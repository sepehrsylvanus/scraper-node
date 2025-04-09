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

// Extract product URLs with scroll and button click
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting with base URL: ${baseUrl}`);
  let allProductUrls = new Set();

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 120000 });
  } catch (error) {
    logProgress("URL_COLLECTION", `Failed to load base URL: ${error.message}`);
    return [];
  }

  const totalProducts = await page.evaluate(() => {
    const resultsElement = document.querySelector(".results-hits span");
    return resultsElement
      ? parseInt(resultsElement.textContent.replace(/[^0-9]/g, ""))
      : 0;
  });
  logProgress("URL_COLLECTION", `Total products expected: ${totalProducts}`);

  if (totalProducts === 0) {
    logProgress("URL_COLLECTION", "No products found on page. Exiting.");
    return [];
  }

  // Scroll and click "See more products" button
  let hasMoreButton = true;
  while (hasMoreButton && !shouldStop) {
    try {
      // Scroll 500px every half second
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

      // Check for and click the "See more products" button
      const buttonSelector =
        "button.see-more-button[data-js-infinitescroll-see-more]";
      hasMoreButton = await page.evaluate((selector) => {
        const button = document.querySelector(selector);
        if (button && button.style.display !== "none" && !button.disabled) {
          button.scrollIntoView({ behavior: "smooth", block: "center" });
          button.click();
          return true;
        }
        return false;
      }, buttonSelector);

      if (hasMoreButton) {
        logProgress("URL_COLLECTION", "Clicked 'Daha fazla ürün gör' button");
        await delay(3000); // Wait for more products to load
      }

      // Collect current URLs
      const currentUrls = await page.evaluate(() => {
        const productElements = document.querySelectorAll(
          ".product-tile.clickable"
        );
        return Array.from(productElements)
          .map((element) => {
            const link = element.querySelector(".product-tile-link");
            return link ? link.href : null;
          })
          .filter((url) => url);
      });

      currentUrls.forEach((url) => allProductUrls.add(url));
      logProgress(
        "URL_COLLECTION",
        `Progress: ${allProductUrls.size}/${totalProducts} unique URLs collected`
      );

      // Break if we've collected all expected products
      if (allProductUrls.size >= totalProducts) {
        break;
      }
    } catch (error) {
      logProgress(
        "URL_COLLECTION",
        `Error during scroll/button click: ${error.message}`
      );
      hasMoreButton = false;
    }
  }

  logProgress(
    "URL_COLLECTION",
    `Collected ${allProductUrls.size}/${totalProducts} products`
  );
  return Array.from(allProductUrls);
};

// Scrape product details with improved error handling
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
        const productIdMatch = url.match(/P(\d+)/);
        const productId = productIdMatch ? productIdMatch[1] : "";

        const priceElement = document.querySelector(
          ".price-sales.price-sales-standard"
        );
        const priceText = priceElement ? priceElement.textContent.trim() : "";
        const price = priceText.match(/([\d.,]+)/)
          ? parseFloat(
              priceText
                .match(/([\d.,]+)/)[1]
                .replace(".", "")
                .replace(",", ".")
            )
          : null;

        const ratingElement = document.querySelector(".bv-overall-score");
        const rating = ratingElement
          ? ratingElement.textContent.trim().split("/")[0]
          : null;

        const specificationsElement = document.querySelector(".specification");
        const specifications = specificationsElement
          ? Array.from(specificationsElement.querySelectorAll("li")).map(
              (spec) => ({
                name: spec.querySelector(".name")?.textContent.trim() || "",
                value: spec.querySelector(".value")?.textContent.trim() || "",
              })
            )
          : [];

        const breadcrumbItems = document.querySelectorAll(
          ".breadcrumb.pdp-breadcrumb .breadcrumb-element"
        );
        const categories = Array.from(breadcrumbItems)
          .slice(0, -1)
          .map((item) => item.querySelector("a")?.textContent.trim() || "")
          .join(" > ");

        const title =
          document.querySelector(".product-name")?.textContent.trim() || "";
        const brand =
          document.querySelector(".brand-name")?.textContent.trim() || "";
        const description =
          document.querySelector(".description-content.product-description-box")
            ?.innerHTML || "";

        return {
          productId,
          brand,
          title,
          price,
          rating,
          specifications,
          categories,
          description,
        };
      }, url);

      if (!productData.title) {
        throw new Error("No product title found");
      }

      return { ...productData, url, currency: "TRY" };
    } catch (error) {
      attempt++;
      logProgress(
        "PRODUCT_SCRAPING",
        `Attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`
      );

      if (attempt === maxRetries) {
        logProgress(
          "PRODUCT_SCRAPING",
          `Skipping product ${url} after max retries`
        );
        return null; // Skip this product
      }

      if (
        error.name === "ProtocolError" ||
        error.message.includes("No target with given id")
      ) {
        logProgress(
          "PRODUCT_SCRAPING",
          "Protocol error detected, recreating page"
        );
        await page.close().catch(() => {});
        page = await browserInstance.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
      }
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
const scrapeSephoraUrls = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node --expose-gc sephora.js <url1> <url2> ...");
    process.exit(1);
  }

  try {
    const sephoraDir = path.join(outputDir, "sephora");
    if (!fs.existsSync(sephoraDir))
      fs.mkdirSync(sephoraDir, { recursive: true });

    browser = await launchBrowser();
    const productsPerBrowserRestart = 50;

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing base URL: ${baseUrl}`);
      let processedUrls = loadExistingUrls(baseUrl, sephoraDir);
      let productDataArray = [];

      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];
      const outputFileName = path.join(
        sephoraDir,
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
          if (productData) {
            productDataArray.push(productData);
            logProgress("MAIN", `Scraped details for ${url}`);
          }
          saveUrlsToFile(productDataArray, outputFileName);
        } catch (error) {
          logProgress(
            "MAIN",
            `Failed to scrape ${url}: ${error.message}, skipping`
          );
          productDataArray.push({ url, error: error.message });
          saveUrlsToFile(productDataArray, outputFileName);
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
      logProgress("MAIN", "Closing browser in finally block...");
      await browser.close().catch(() => {});
      triggerGC();
    }
    process.exit(0);
  }
};

if (typeof global.gc === "undefined") {
  console.log(
    "Run with --expose-gc to enable manual garbage collection: node --expose-gc sephora.js <url>"
  );
}

scrapeSephoraUrls();
