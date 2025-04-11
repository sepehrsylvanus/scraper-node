const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

let browser;
let shouldStop = false;

const today = new Date();
const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
  2,
  "0"
)}-${String(today.getDate()).padStart(2, "0")}`;

// Utility to delay execution with randomization
const delay = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms + Math.random() * 100));

// Custom logging function
const logProgress = (level, message) => {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] ${message}\n`);
};

// Log memory usage
const logMemoryUsage = () => {
  const memoryUsage = process.memoryUsage();
  logProgress(
    "DEBUG",
    `Memory usage: RSS=${(memoryUsage.rss / 1024 / 1024).toFixed(2)}MB, Heap=${(
      memoryUsage.heapUsed /
      1024 /
      1024
    ).toFixed(2)}MB`
  );
};

// Trigger garbage collection if available
const triggerGC = () => {
  if (global.gc) {
    logProgress("GC", "Triggering garbage collection...");
    global.gc();
    logMemoryUsage();
  }
};

// Launch browser with retry logic
const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (browser && browser.process() != null) {
        logProgress("BROWSER", "Closing existing browser instance...");
        await browser.close();
        triggerGC();
        await delay(2000);
      }
      logProgress("BROWSER", `Launching browser (attempt ${i + 1})...`);
      browser = await puppeteer.launch({
        headless: false,
        protocolTimeout: 86400000,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-zygote",
        ],
      });
      logProgress("BROWSER", "Browser launched successfully");
      return browser;
    } catch (error) {
      logProgress(
        "ERROR",
        `Browser launch attempt ${i + 1} failed: ${error.message}`
      );
      if (i === retries - 1) throw error;
      await delay(2000);
    }
  }
};

// Extract product URLs, titles, and prices with a single scroll
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting with base URL: ${baseUrl}`);
  let allProducts = new Set();

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 120000 });
  } catch (error) {
    logProgress("URL_COLLECTION", `Failed to load base URL: ${error.message}`);
    return [];
  }

  try {
    // Perform a single scroll to load all visible products
    await page.evaluate(async () => {
      let currentPosition = 0;
      const scrollStep = 250;
      const maxHeight = document.body.scrollHeight;
      while (currentPosition < maxHeight) {
        window.scrollBy(0, scrollStep);
        currentPosition += scrollStep;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    });

    await page.waitForSelector("div.prd", { timeout: 10000 }).catch(() => {});

    const currentProducts = await page.evaluate(() => {
      const productCards = document.querySelectorAll("div.prd");
      return Array.from(productCards)
        .map((card) => {
          const linkElement = card.querySelector("a");
          const titleElement = card.querySelector("td[height='42'] a");
          const priceElement = card.querySelector(
            "td[background*='mbg.jpg'] div"
          );

          const url = linkElement ? linkElement.getAttribute("href") : null;
          const title = titleElement ? titleElement.textContent.trim() : "";
          let price = null;
          if (priceElement) {
            const priceText = priceElement.textContent
              .replace(/[^\d.,]/g, "")
              .replace(",", ".");
            price = parseFloat(priceText) || null;
          }

          return url && title && url.includes("urunDetay")
            ? { url, title, price }
            : null;
        })
        .filter((item) => item !== null);
    });

    currentProducts.forEach((product) => {
      allProducts.add(JSON.stringify(product));
    });
    logProgress(
      "URL_COLLECTION",
      `Collected ${allProducts.size} unique products`
    );
  } catch (error) {
    logProgress(
      "URL_COLLECTION",
      `Error during product collection: ${error.message}`
    );
  }

  logProgress(
    "URL_COLLECTION",
    `Total unique products collected: ${allProducts.size}`
  );
  return Array.from(allProducts).map((item) => JSON.parse(item));
};

// Scrape product details
const scrapeProductDetails = async (
  page,
  product,
  category,
  browserInstance,
  maxRetries = 3
) => {
  const { url, title, price } = product;
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

      const productData = await page.evaluate(
        (url, title, price, category) => {
          const brand = "Missha";
          const currency = "₺";
          const baseUrl = "https://missha.com.tr";

          // Use provided category
          const categories = category;

          // Extract description
          let description = "";
          const descriptionElement = document.querySelector("#ozetDiv.icerik");
          if (descriptionElement) {
            description = descriptionElement.innerHTML.trim();
          }

          // Extract product ID
          let productId = "";
          const productIdElement = document.querySelector(
            "td[bgcolor='#F6F6F6'] strong"
          );
          if (
            productIdElement &&
            productIdElement.textContent.includes("Ürün Kodu")
          ) {
            productId = productIdElement.parentElement.textContent
              .replace(/.*Ürün Kodu\s*:\s*/, "")
              .trim();
          }

          // Extract images from specific table
          let images = [];
          const mainImageElement = document.querySelector(
            "td#pimage img#prdimg"
          );
          if (mainImageElement) {
            const mainImageSrc = mainImageElement.getAttribute("src");
            if (mainImageSrc) images.push(baseUrl + mainImageSrc);
          }

          const galleryElements = document.querySelectorAll(
            "#gallery_09 a.elevatezoom-gallery"
          );
          galleryElements.forEach((el) => {
            const imgSrc = el.getAttribute("data-image");
            const fullImgSrc = baseUrl + imgSrc;
            if (imgSrc && !images.includes(fullImgSrc)) images.push(fullImgSrc);
          });

          const imagesString = images.join(";");

          return {
            brand,
            title,
            price,
            currency,
            images: imagesString,
            description,
            productId,
            url,
            categories,
          };
        },
        url,
        title,
        price,
        category
      );

      if (!productData.title) throw new Error("Missing title");
      return productData;
    } catch (error) {
      attempt++;
      logProgress(
        "PRODUCT_SCRAPING",
        `Attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`
      );
      if (attempt === maxRetries) return null;
      await delay(2000);
    }
  }
};

// Save data to file
const saveUrlsToFile = (data, filePath) => {
  const filteredData = data.filter((item) => item !== null);
  fs.writeFileSync(filePath, JSON.stringify(filteredData, null, 2));
  logProgress(
    "FILE",
    `Saved ${filteredData.length} product entries to ${filePath}`
  );
};

// Load existing URLs
const loadExistingUrls = (baseUrl, dir) => {
  const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
  const existingFiles = fs
    .readdirSync(dir)
    .filter((file) => file.includes(urlSlug) && file.endsWith(".json"));
  const existingUrls = new Set();

  for (const file of existingFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      data.forEach((entry) => entry?.url && existingUrls.add(entry.url));
    } catch (error) {
      logProgress("FILE", `Error reading ${file}: ${error.message}`);
    }
  }
  return existingUrls;
};

// Main scraping function
const scrapeWebsite = async () => {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.length % 2 !== 0) {
    console.error(
      "Usage: node --expose-gc script.js <url1> <category1> <url2> <category2> ..."
    );
    process.exit(1);
  }

  // Pair URLs with categories
  const urlCategoryPairs = [];
  for (let i = 0; i < args.length; i += 2) {
    urlCategoryPairs.push({ url: args[i], category: args[i + 1] });
  }

  try {
    const siteDir = path.join(outputDir, "missha");
    if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });

    browser = await launchBrowser();
    const productsPerBrowserRestart = 50;

    for (const { url: baseUrl, category } of urlCategoryPairs) {
      logProgress(
        "MAIN",
        `Processing base URL: ${baseUrl} with category: ${category}`
      );
      let processedUrls = loadExistingUrls(baseUrl, siteDir);
      let productDataArray = [];

      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];
      const outputFileName = path.join(
        siteDir,
        `products_${dateStr}_${urlSlug}_${timestamp}.json`
      );

      let page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      const products = await extractProductUrls(page, baseUrl);
      await page.close().catch(() => {});
      triggerGC();

      logProgress("MAIN", `Found ${products.length} products`);
      let productCount = 0;

      for (const product of products) {
        if (processedUrls.has(product.url)) {
          logProgress("MAIN", `Skipping already processed URL: ${product.url}`);
          continue;
        }

        if (
          productCount > 0 &&
          productCount % productsPerBrowserRestart === 0
        ) {
          logProgress(
            "MAIN",
            `Restarting browser after ${productCount} products...`
          );
          await browser.close().catch(() => {});
          triggerGC();
          await delay(3000);
          browser = await launchBrowser();
        }

        const productPage = await browser.newPage();
        await productPage.setViewport({ width: 1366, height: 768 });
        await productPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );

        try {
          const productData = await scrapeProductDetails(
            productPage,
            product,
            category,
            browser
          );
          if (productData) {
            productDataArray.push(productData);
            saveUrlsToFile(productDataArray, outputFileName);
          }
        } catch (error) {
          logProgress(
            "MAIN",
            `Failed to scrape ${product.url}: ${error.message}`
          );
        } finally {
          await productPage.close().catch(() => {});
          triggerGC();
          await delay(2000);
          productCount++;
        }
      }
    }
  } catch (error) {
    logProgress("FATAL", `Fatal error: ${error.message}`);
  } finally {
    if (browser && browser.process() != null) {
      await browser.close().catch(() => {});
      triggerGC();
    }
    process.exit(0);
  }
};

if (typeof global.gc === "undefined") {
  console.log(
    "Run with --expose-gc to enable manual garbage collection: node --expose-gc script.js <url> <category> ..."
  );
}

scrapeWebsite();
