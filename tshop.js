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
  new Promise((resolve) => setTimeout(resolve, ms + Math.random() * 1000));

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
      console.error(`Browser launch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await delay(2000);
    }
  }
};

// Extract product URLs with infinite scroll based on total products
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting with base URL: ${baseUrl}`);
  let allProductUrls = new Set();

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 120000 });
  } catch (error) {
    logProgress("URL_COLLECTION", `Failed to load base URL: ${error.message}`);
    return [];
  }

  // Extract total product count
  const totalProducts = await page.evaluate(() => {
    const totalElement = document.querySelector(
      ".scrolled_list-main span.text-xs"
    );
    return totalElement
      ? parseInt(totalElement.textContent.replace(/[^\d]/g, ""), 10)
      : 0;
  });
  logProgress("URL_COLLECTION", `Total products expected: ${totalProducts}`);

  // Infinite scroll with improved detection
  let lastUrlCount = 0;
  let noNewUrlsCount = 0;
  const maxNoNewUrls = 3; // Stop after 3 scrolls with no new URLs

  while (!shouldStop && allProductUrls.size < totalProducts) {
    try {
      // Perform scroll
      await page.evaluate(async () => {
        let currentPosition = 0;
        const scrollStep = 500;
        const maxHeight = document.body.scrollHeight;

        while (currentPosition < maxHeight) {
          window.scrollBy(0, scrollStep);
          currentPosition += scrollStep;
          await new Promise((resolve) => setTimeout(resolve, 500)); // Half second delay
        }
      });

      // Wait for product elements to load
      await page.waitForSelector("div[data-id] a[href]", { timeout: 10000 });

      // Collect URLs from product links
      const currentUrls = await page.evaluate(() => {
        const productLinks = document.querySelectorAll(
          "div[data-id] > a[href]"
        );
        return Array.from(productLinks)
          .map((link) => {
            const href = link.getAttribute("href");
            if (href && href.startsWith("/")) {
              return `https://tshop.com.tr${href}`;
            }
            return href;
          })
          .filter((url) => url && !url.includes("#"));
      });

      const previousSize = allProductUrls.size;
      currentUrls.forEach((url) => allProductUrls.add(url));
      logProgress(
        "URL_COLLECTION",
        `Collected ${allProductUrls.size}/${totalProducts} unique URLs`
      );

      // Check if new URLs were added
      if (allProductUrls.size === previousSize) {
        noNewUrlsCount++;
        logProgress(
          "URL_COLLECTION",
          `No new URLs found (streak: ${noNewUrlsCount}/${maxNoNewUrls})`
        );
        if (noNewUrlsCount >= maxNoNewUrls) {
          logProgress(
            "URL_COLLECTION",
            "No new URLs after multiple scrolls, ending scroll"
          );
          break;
        }
      } else {
        noNewUrlsCount = 0; // Reset streak if new URLs are found
      }

      // Break if we've reached or exceeded the total products
      if (allProductUrls.size >= totalProducts) {
        logProgress(
          "URL_COLLECTION",
          "Reached or exceeded expected product count, stopping"
        );
        break;
      }

      // Wait a bit before the next scroll
      await delay(1000);
    } catch (error) {
      logProgress("URL_COLLECTION", `Error during scroll: ${error.message}`);
      break;
    }
  }

  logProgress(
    "URL_COLLECTION",
    `Total unique URLs collected: ${allProductUrls.size}`
  );
  return Array.from(allProductUrls);
};

// Scrape product details
const scrapeProductDetails = async (
  page,
  url,
  browserInstance,
  maxRetries = 3
) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

      const productData = await page.evaluate((url) => {
        // Brand
        const brandElement = document.querySelector(".brand-name");
        const brand = brandElement ? brandElement.textContent.trim() : "";

        // Title
        const titleElement = document.querySelector(".product-name");
        const title = titleElement ? titleElement.textContent.trim() : "";

        // Price (only discounted price)
        const priceElement = document.querySelector(
          ".discount-price span:last-child"
        );
        const price = priceElement
          ? parseFloat(
              priceElement.textContent.replace(/[^\d.,]/g, "").replace(",", ".")
            )
          : null;

        // Currency
        const currency = "TRY";

        // Images from slider (thumbnail and main images)
        const imageElements = document.querySelectorAll(
          ".image-slider .slide img"
        );
        const images = Array.from(imageElements)
          .map((img) => img.src)
          .filter((src) => src && src.includes("myikas.com")); // Filter valid image URLs
        const imageString = images.join(";");

        // Description (excluding h2)
        const descriptionElement = document.querySelector(".tab-content");
        let description = "";
        if (descriptionElement) {
          const h2 = descriptionElement.querySelector("h2");
          if (h2) h2.remove(); // Remove h2 from the content
          description = descriptionElement.textContent.trim();
        }

        // Product ID
        const productIdElement = document.querySelector(
          ".categories-detail.mt-4 span:last-child"
        );
        const productId = productIdElement
          ? productIdElement.textContent.trim()
          : "";

        return {
          brand,
          title,
          price,
          currency,
          images: imageString,
          description,
          productId,
          url,
        };
      }, url);

      if (!productData.title || !productData.brand)
        throw new Error("Missing title or brand");

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
      console.error(`Error reading ${file}:`, error.message);
    }
  }
  return existingUrls;
};

// Main scraping function
const scrapeWebsite = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node --expose-gc script.js <url1> <url2> ...");
    process.exit(1);
  }

  try {
    const siteDir = path.join(outputDir, "tshop");
    if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });

    browser = await launchBrowser();
    const productsPerBrowserRestart = 50;

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing base URL: ${baseUrl}`);
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

      const productUrls = await extractProductUrls(page, baseUrl);
      await page.close().catch(() => {});
      triggerGC();

      logProgress("MAIN", `Found ${productUrls.length} product URLs`);
      let productCount = 0;

      for (const url of productUrls) {
        if (processedUrls.has(url)) {
          logProgress("MAIN", `Skipping already processed URL: ${url}`);
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
            url,
            browser
          );
          if (productData) productDataArray.push(productData);
          saveUrlsToFile(productDataArray, outputFileName);
        } catch (error) {
          logProgress("MAIN", `Failed to scrape ${url}: ${error.message}`);
        } finally {
          await productPage.close().catch(() => {});
          triggerGC();
          await delay(4000);
          productCount++;
        }
      }
    }
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
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
    "Run with --expose-gc to enable manual garbage collection: node --expose-gc script.js <url>"
  );
}

scrapeWebsite();
