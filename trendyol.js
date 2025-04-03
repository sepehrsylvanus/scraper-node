const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

let browser;
let shouldStop = false;

const today = new Date();
const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
  2,
  "0"
)}-${String(today.getDate()).padStart(2, "0")}`;

// Utility to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Custom logging function
const logProgress = (level, message) => {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] ${message}\n`);
};

// Random user agents
const getRandomUserAgent = () => {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.96 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Launch browser with retry logic
const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (browser && browser.isConnected()) return browser;
      logProgress("BROWSER", `Launching browser (attempt ${i + 1})...`);
      browser = await puppeteer.launch({
        headless: false,
        protocolTimeout: 86400000,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await delay(2000);
    }
  }
};

// Extract product URLs from Trendyol listing page
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting scrape for: ${baseUrl}`);
  await page.setUserAgent(getRandomUserAgent());
  await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 60000 });

  const totalProductsInfo = await page.evaluate(() => {
    const descElement = document.querySelector(".dscrptn.dscrptn-V2 h2");
    return descElement
      ? descElement.textContent
          .trim()
          .match(/([\d.]+)(\+)?\s+sonuç/)
          ?.slice(1)
      : [0, false];
  });
  const totalProducts = parseFloat(totalProductsInfo[0]?.replace(".", "") || 0);
  const isIndeterminate = !!totalProductsInfo[1];

  let allProductUrls = new Set();
  let previousHeight = 0;
  let stagnantCount = 0;
  const maxStagnantAttempts = 5;

  while (!shouldStop) {
    try {
      const currentUrls = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll(".p-card-chldrn-cntnr.card-border a")
        )
          .map((el) => el.getAttribute("href"))
          .filter((url) => url && !url.includes("javascript:"))
          .map((url) =>
            url.startsWith("http")
              ? url
              : new URL(url, "https://www.trendyol.com").href
          );
      });

      currentUrls.forEach((url) => allProductUrls.add(url));
      logProgress(
        "URL_COLLECTION",
        `Found ${allProductUrls.size} unique URLs so far...`
      );

      if (!isIndeterminate && allProductUrls.size >= totalProducts) break;

      await page.evaluate(() => window.scrollBy(0, 1000));
      await delay(2000);

      const currentHeight = await page.evaluate(
        () => document.body.scrollHeight
      );
      if (currentHeight === previousHeight) {
        stagnantCount++;
        if (stagnantCount >= maxStagnantAttempts) break;
      } else {
        stagnantCount = 0;
      }
      previousHeight = currentHeight;

      if (
        await page.evaluate(
          () =>
            window.scrollY + window.innerHeight >= document.body.scrollHeight
        )
      )
        break;
    } catch (error) {
      logProgress(
        "URL_COLLECTION",
        `Error: ${error.message}. Attempting to recover...`
      );
      await delay(2000);
    }
  }

  return {
    productUrls: Array.from(allProductUrls),
    totalProducts,
    isIndeterminate,
  };
};

// Scrape product details with improved error handling
const scrapeProductDetails = async (page, url) => {
  try {
    await page.setUserAgent(getRandomUserAgent());
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    const productDetails = await page.evaluate(() => {
      const imageSources = new Set();
      document
        .querySelectorAll(
          ".base-product-image img, .gallery-modal img, .product-slide.thumbnail-feature img"
        )
        .forEach((img) => {
          let src =
            img.getAttribute("src")?.replace(/(\d+x\d+|thumbnail)/g, "") || "";
          if (src) imageSources.add(src);
        });

      const brand =
        document
          .querySelector("span.product-description-market-place")
          ?.textContent.trim() || null;
      const title =
        document.querySelector("h3.detail-name")?.textContent.trim() || null;

      const priceText =
        document.querySelector("span.prc-dsc")?.textContent.trim() || "";
      const priceMatch = priceText.match(/([\d.,]+)\s*(\w+)/);
      const price = priceMatch
        ? parseFloat(priceMatch[1].replace(",", "."))
        : null;
      const currency = priceMatch ? priceMatch[2] : null;

      const rating =
        document
          .querySelector(".product-rating-score .value")
          ?.textContent.trim() || null;

      const specifications = Array.from(
        document.querySelectorAll(".detail-attr-container .detail-attr-item")
      ).map((spec) => ({
        name: spec.querySelector(".attr-key-name-w")?.textContent.trim() || "",
        value:
          spec.querySelector(".attr-value-name-w")?.textContent.trim() || "",
      }));

      const categories = Array.from(
        document.querySelectorAll(".product-detail-breadcrumb-item span")
      )
        .map((el) => el.textContent.trim())
        .filter((cat) => cat !== "Trendyol" && !cat.includes("Baby Turco"))
        .join(">");

      const descriptionHtml =
        document.querySelector(".detail-border")?.outerHTML || null;

      return {
        brand,
        title,
        price,
        currency,
        images: Array.from(imageSources).join(";"),
        rating,
        specifications,
        categories,
        descriptionHtml,
      };
    });

    const productId = url.match(/p-(\d+)/)?.[1] || null;

    return {
      url,
      productId,
      brand: productDetails.brand,
      title: productDetails.title,
      price: productDetails.price,
      currency: productDetails.currency,
      images: productDetails.images,
      rating: productDetails.rating ? parseFloat(productDetails.rating) : null,
      specifications: productDetails.specifications,
      categories: productDetails.categories,
      description: productDetails.descriptionHtml,
    };
  } catch (error) {
    logProgress("DETAIL", `Error scraping ${url}: ${error.message}`);
    return {
      url,
      productId: null,
      brand: null,
      title: null,
      price: null,
      currency: null,
      images: null,
      rating: null,
      specifications: [],
      categories: "",
      description: null,
    };
  }
};

// Save products to file
const saveProductsToFile = (products, filePath) => {
  fs.writeFileSync(filePath, JSON.stringify(products, null, 2));
  logProgress("FILE", `Saved ${products.length} products to ${filePath}`);
};

// Load existing products
const loadExistingProducts = (baseUrl, dir) => {
  const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
  const existingFiles = fs
    .readdirSync(dir)
    .filter((file) => file.includes(urlSlug) && file.endsWith(".json"));
  const existingProducts = new Set();

  for (const file of existingFiles) {
    try {
      const products = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf8")
      );
      products.forEach(
        (product) => product.url && existingProducts.add(product.url)
      );
    } catch (error) {
      console.error(`Error reading ${file}:`, error.message);
    }
  }
  return existingProducts;
};

// Main scraping function
const scrapeMultipleUrls = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node script.js <url1> <url2> ...");
    process.exit(1);
  }

  try {
    const trendyolDir = path.join(outputDir, "trendyol");
    if (!fs.existsSync(trendyolDir))
      fs.mkdirSync(trendyolDir, { recursive: true });

    browser = await launchBrowser();

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing: ${baseUrl}`);
      const processedUrls = loadExistingProducts(baseUrl, trendyolDir);
      let productsArray = [];

      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];
      const outputFileName = path.join(
        trendyolDir,
        `products_${dateStr}_${urlSlug}_${timestamp}.json`
      );

      const mainPage = await browser.newPage();
      await mainPage.setViewport({ width: 1366, height: 768 });

      const { productUrls } = await extractProductUrls(mainPage, baseUrl);
      await mainPage.close();

      logProgress("MAIN", `Found ${productUrls.length} product URLs`);

      const detailPage = await browser.newPage();
      await detailPage.setViewport({ width: 1366, height: 768 });

      for (let i = 0; i < productUrls.length && !shouldStop; i++) {
        if (processedUrls.has(productUrls[i])) {
          logProgress(
            "MAIN",
            `Skipping already processed URL: ${productUrls[i]}`
          );
          continue;
        }

        const productDetails = await scrapeProductDetails(
          detailPage,
          productUrls[i]
        );
        productsArray.push(productDetails);

        logProgress(
          "MAIN",
          `Processed ${i + 1}/${productUrls.length} products`
        );
        saveProductsToFile(productsArray, outputFileName);

        // Add random delay and recreate page periodically to prevent freezing
        await delay(1000 + Math.random() * 2000);
        if (i % 10 === 0 && i > 0) {
          await detailPage.close();
          const newDetailPage = await browser.newPage();
          await newDetailPage.setViewport({ width: 1366, height: 768 });
          detailPage = newDetailPage;
        }
      }

      await detailPage.close();
      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productsArray.length} products saved`
      );
    }

    if (browser) await browser.close();
    process.exit(0);
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
    if (browser) await browser.close();
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on("SIGINT", async () => {
  shouldStop = true;
  logProgress("SHUTDOWN", "Received SIGINT. Shutting down gracefully...");
  if (browser) await browser.close();
  process.exit(0);
});

scrapeMultipleUrls();
