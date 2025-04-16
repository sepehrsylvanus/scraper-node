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

const delay = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms + Math.random() * 1000));

const logProgress = (level, message) => {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] ${message}\n`);
};

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

const triggerGC = () => {
  if (global.gc) {
    logProgress("GC", "Triggering garbage collection...");
    global.gc();
    logMemoryUsage();
  }
};

const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (browser && browser.process() != null) {
        logProgress("BROWSER", "Closing existing browser instance...");
        await browser.close();
        browser = null;
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
        "BROWSER",
        `Browser launch attempt ${i + 1} failed: ${error}`
      );
      if (i === retries - 1) throw error;
      await delay(2000);
    }
  }
};
// Extract product URLs with cookie consent and infinite scroll
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting with base URL: ${baseUrl}`);
  let allProductUrls = new Set();

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 120000 });
  } catch (error) {
    logProgress("URL_COLLECTION", `Failed to load base URL: ${error.message}`);
    return [];
  }

  // Handle cookie consent popup
  const acceptButtonSelector = "#471ec3c7-64ab-4e76-8eb2-3881b0c27953"; // "Kabul Et" button ID
  try {
    await page.waitForSelector(acceptButtonSelector, { timeout: 10000 });
    await page.click(acceptButtonSelector);
    logProgress("URL_COLLECTION", "Clicked 'Kabul Et' button");
    await delay(2000);
  } catch (error) {
    logProgress(
      "URL_COLLECTION",
      "No cookie consent popup found or already accepted"
    );
  }

  // Extract total product count
  const totalProducts = await page.evaluate(() => {
    const totalElement = document.querySelector(
      "#filter-section .mr-4.font-500.d-md-block"
    );
    return totalElement
      ? parseInt(totalElement.textContent.replace(/[^\d]/g, ""), 10)
      : 0;
  });
  logProgress("URL_COLLECTION", `Total products expected: ${totalProducts}`);

  // Infinite scroll
  let previousHeight = 0;
  while (!shouldStop) {
    try {
      await page.evaluate(async () => {
        window.scrollTo(0, document.body.scrollHeight);
      });

      // Wait for new content to load
      await page
        .waitForFunction(`document.body.scrollHeight > ${previousHeight}`, {
          timeout: 10000,
        })
        .catch(() => {});

      previousHeight = await page.evaluate(() => document.body.scrollHeight);

      // Check for loading indicators
      let isLoading = await page.evaluate(() => {
        const loaders = document.querySelectorAll(
          ".loading, .spinner, [class*='loader'], [style*='display: block']"
        );
        return Array.from(loaders).some(
          (el) => el.offsetParent !== null && el.style.display !== "none"
        );
      });

      while (isLoading && !shouldStop) {
        logProgress(
          "URL_COLLECTION",
          "Loading indicator detected, pausing scroll..."
        );
        await delay(1000);
        isLoading = await page.evaluate(() => {
          const loaders = document.querySelectorAll(
            ".loading, .spinner, [class*='loader'], [style*='display: block']"
          );
          return Array.from(loaders).some(
            (el) => el.offsetParent !== null && el.style.display !== "none"
          );
        });
      }

      // Collect URLs
      const currentUrls = await page.evaluate(() => {
        const productElements = document.querySelectorAll(
          ".product--item .thumbnail-container a[data-discover='true']"
        );
        return Array.from(productElements)
          .map((element) => element.href)
          .filter((url) => url);
      });

      const previousSize = allProductUrls.size;
      currentUrls.forEach((url) => allProductUrls.add(url));
      logProgress(
        "URL_COLLECTION",
        `Collected ${allProductUrls.size}/${totalProducts} unique URLs`
      );

      // Break conditions
      if (allProductUrls.size === previousSize) {
        logProgress("URL_COLLECTION", "No new products loaded, ending scroll");
        break;
      }
      if (totalProducts && allProductUrls.size >= totalProducts) {
        logProgress(
          "URL_COLLECTION",
          "Reached expected product count, stopping"
        );
        break;
      }
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
const scrapeProductDetails = async (page, url, maxRetries = 3) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

      const productData = await page.evaluate((url) => {
        const titleElement = document.querySelector(
          ".product-single__title.mb-0"
        );
        const brandElement = titleElement?.querySelector("a");
        const titleSpan = titleElement?.querySelector("span");
        const brand = brandElement ? brandElement.textContent.trim() : "";
        const title = titleSpan ? titleSpan.textContent.trim() : "";

        const priceElement = document.querySelector(
          ".evecard-text-color span[content]"
        );
        const priceText = priceElement ? priceElement.textContent.trim() : "";
        const price = priceText
          ? parseFloat(priceText.replace(/[^\d.,]/g, "").replace(",", "."))
          : null;

        const currencyElement = document.querySelector(".evecard-text-color");
        const currencySymbol = currencyElement?.textContent.includes("₺")
          ? "TRY"
          : "";

        const descriptionElement = document.querySelector(
          ".tab-content .tab-pane.active .pl-4.pr-4"
        );
        const description = descriptionElement
          ? descriptionElement.textContent.trim()
          : "";

        const productIdElement = document.querySelector(
          ".product-single__sku .label-sku.variant-sku"
        );
        const productId = productIdElement
          ? productIdElement.textContent.trim()
          : "";

        const imageUrls = [];
        const badgeImage = document.querySelector(
          ".product-detail-badge-image img"
        );
        if (badgeImage) imageUrls.push(badgeImage.src);
        const slideElements = document.querySelectorAll(".swiper-slide");
        slideElements.forEach((slide) => {
          const imageSrc = slide.getAttribute("data-image_src");
          if (imageSrc && !imageUrls.includes(imageSrc))
            imageUrls.push(imageSrc);
        });
        const images = imageUrls.join(";");

        const breadcrumbItems = document.querySelectorAll(
          ".breadcrumb li span[itemprop='name']"
        );
        const categoriesArray = Array.from(breadcrumbItems)
          .map((item) => item.textContent.trim())
          .filter(
            (cat, index, arr) => cat !== "Anasayfa" && index !== arr.length - 1
          );
        const categories = categoriesArray.join(">");

        return {
          brand,
          title,
          price,
          currency: currencySymbol,
          description,
          productId,
          images,
          categories,
        };
      }, url);

      if (!productData.title || !productData.brand) {
        throw new Error("Missing title or brand");
      }

      return { ...productData, url };
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
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node --expose-gc script.js <url1> <url2> ...");
    process.exit(1);
  }

  try {
    const siteDir = path.join(outputDir, "eveshop");
    if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });

    browser = await launchBrowser();

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

      for (let i = 0; i < productUrls.length; i++) {
        const url = productUrls[i];
        if (processedUrls.has(url)) {
          logProgress("MAIN", `Skipping already processed URL: ${url}`);
          continue;
        }

        const productPage = await browser.newPage();
        await productPage.setViewport({ width: 1366, height: 768 });
        await productPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );

        try {
          const productData = await scrapeProductDetails(productPage, url);
          if (productData) {
            productDataArray.push(productData);
            processedUrls.add(url);
            saveUrlsToFile(productDataArray, outputFileName);
          }
          logProgress(
            "MAIN",
            `Processed ${i + 1}/${productUrls.length} products`
          );
        } catch (error) {
          logProgress("MAIN", `Failed to scrape ${url}: ${error.message}`);
        } finally {
          await productPage.close().catch(() => {});
          triggerGC();
          await delay(2000);
        }

        // Optional: Restart browser every 100 products to manage memory
        if ((i + 1) % 100 === 0) {
          logProgress("MAIN", `Restarting browser after ${i + 1} products...`);
          await browser.close().catch(() => {});
          triggerGC();
          await delay(3000);
          browser = await launchBrowser();
        }
      }

      logProgress("MAIN", `Completed processing for ${baseUrl}`);
      saveUrlsToFile(productDataArray, outputFileName);
    }
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
  } finally {
    if (browser && browser.process() != null) {
      await browser.close().catch(() => {});
      triggerGC();
    }
    logProgress("MAIN", "Scraping completed");
    process.exit(0);
  }
};

if (typeof global.gc === "undefined") {
  console.log(
    "Run with --expose-gc to enable manual garbage collection: node --expose-gc script.js <url>"
  );
}

scrapeWebsite();
