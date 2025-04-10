const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

let browser;

const today = new Date();
const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
  2,
  "0"
)}-${String(today.getDate()).padStart(2, "0")}`;

// Utility to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Custom logging function
const logProgress = (level, message) => {
  console.log(`[${new Date().toISOString()}] [${level}] ${message}`);
};

// Enhanced memory management function with heap usage logging
const cleanupMemory = () => {
  if (global.gc) {
    global.gc();
    const memoryUsage = process.memoryUsage();
    logProgress(
      "MEMORY",
      `Garbage collection triggered. Heap used: ${Math.round(
        memoryUsage.heapUsed / 1024 / 1024
      )} MB, Heap total: ${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`
    );
  } else {
    logProgress(
      "MEMORY",
      "Garbage collection not available - run with --expose-gc"
    );
  }
};

// Large pool of realistic user agents
const getRandomUserAgent = () => {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/114.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Launch browser with stealth enhancements
const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      logProgress("BROWSER", `Launching browser (attempt ${i + 1})...`);
      browser = await puppeteer.launch({
        headless: false,
        protocolTimeout: 180000,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--disable-gpu",
          "--expose-gc", // Ensure garbage collection is exposed
        ],
        defaultViewport: { width: 1280, height: 800 },
      });
      logProgress("BROWSER", "Browser launched successfully");
      cleanupMemory(); // Clean up after launch
      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await delay(2000);
    }
  }
};

// Simulate human-like behavior
const simulateHumanBehavior = async (page) => {
  try {
    await page.evaluate(() => {
      const x = Math.floor(Math.random() * 800) + 200;
      const y = Math.floor(Math.random() * 600) + 100;
      window.scrollTo(x, y);
    });
    await delay(Math.random() * 1000 + 500);
  } catch (error) {
    logProgress("SIMULATION", `Failed to simulate behavior: ${error.message}`);
  }
};

// Handle infinite scroll with loading layer
const scrollUntilNoMoreContent = async (page, maxScrolls = 50) => {
  let previousHeight = 0;
  let scrollCount = 0;

  while (scrollCount < maxScrolls) {
    const isLoading = await page.evaluate(() => {
      const loadingLayer = document.querySelector(".loading");
      return loadingLayer && loadingLayer.style.display !== "none";
    });

    if (isLoading) {
      logProgress("SCROLLING", "Waiting for loading layer to disappear...");
      await page.waitForFunction(
        () => {
          const loadingLayer = document.querySelector(".loading");
          return !loadingLayer || loadingLayer.style.display === "none";
        },
        { timeout: 30000 }
      );
      logProgress("SCROLLING", "Loading layer gone, continuing scroll");
    }

    const currentHeight = await page.evaluate(() => {
      window.scrollBy(0, 1000);
      return document.body.scrollHeight;
    });

    if (currentHeight === previousHeight) {
      logProgress(
        "SCROLLING",
        "No new content loaded, assuming end of infinite scroll"
      );
      break;
    }

    previousHeight = currentHeight;
    scrollCount++;
    logProgress(
      "SCROLLING",
      `Scroll ${scrollCount}: New height ${currentHeight}`
    );
    await delay(2000);
    cleanupMemory(); // Clean up after each scroll
  }

  if (scrollCount >= maxScrolls) {
    logProgress("SCROLLING", "Max scrolls reached, stopping");
  }
};

// Extract product ID from URL
const getProductIdFromUrl = (url) => {
  const urlParams = new URLSearchParams(url.split("?")[1]);
  return urlParams.get("pid") || "ID not found";
};

// Scrape product details from individual product page
const scrapeProductDetails = async (page, url, retries = 3) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await page.setUserAgent(getRandomUserAgent());
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        Referer: "https://www.farmasi.com.tr/",
        "Upgrade-Insecure-Requests": "1",
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

      // Handle cookie consent popup
      try {
        await page.waitForSelector(".cc-nb-okagree", { timeout: 5000 });
        await page.click(".cc-nb-okagree");
        logProgress("PRODUCT_SCRAPING", "Accepted all cookies");
        await delay(1000);
      } catch (e) {
        logProgress(
          "PRODUCT_SCRAPING",
          "No cookie popup found or failed to click: " + e.message
        );
      }

      await page.waitForSelector(".LongName.ProductNameDesktop", {
        timeout: 30000,
      });
      await simulateHumanBehavior(page);

      const productData = await page.evaluate(() => {
        const titleElement = document.querySelector(
          ".LongName.ProductNameDesktop"
        );
        const title = titleElement
          ? titleElement.textContent.trim()
          : "Title not found";

        const priceContainer = document.querySelector(".ProductActualPrice");
        let price = null;
        let currency = "";
        if (priceContainer) {
          const priceElement = priceContainer.querySelector(".MinPrice");
          price = priceElement
            ? parseFloat(priceElement.textContent.trim())
            : null;
          const priceText = priceContainer.textContent.trim();
          currency = priceText
            .replace(priceElement ? priceElement.textContent : "", "")
            .trim();
        }

        const imageElement = document.querySelector(
          ".appendProductImages img.zoomImage-1.controlZoom.lazyImage"
        );
        const images = imageElement
          ? imageElement.getAttribute("src") ||
            imageElement.getAttribute("data-src")
          : "Image not found";

        const rating = null;

        const descriptionElement = document.querySelector(
          "#ProductDescription.Description"
        );
        const description = descriptionElement
          ? descriptionElement.innerHTML.trim()
          : "Description not found";

        return { title, price, currency, images, rating, description };
      });

      cleanupMemory(); // Clean up after scraping each product
      return {
        url,
        productId: getProductIdFromUrl(url),
        title: productData.title,
        price: productData.price,
        currency: productData.currency || "TL",
        images: productData.images,
        rating: productData.rating,
        description: productData.description,
      };
    } catch (error) {
      logProgress(
        "PRODUCT_SCRAPING",
        `Attempt ${attempt + 1} failed: ${error.message}`
      );
      if (attempt === retries - 1) {
        return {
          url,
          productId: getProductIdFromUrl(url),
          title: "Failed to scrape",
          price: null,
          currency: "TL",
          images: "Image not found",
          rating: null,
          description: "Failed to scrape",
        };
      }
      await delay(5000);
    }
  }
};

// Save data to file
const saveUrlsToFile = (data, filePath) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  logProgress("FILE", `Saved ${data.length} product entries to ${filePath}`);
  cleanupMemory(); // Clean up after saving
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
      const data = fs.readFileSync(path.join(dir, file), "utf8");
      const entries = JSON.parse(data);
      entries.forEach((entry) => existingUrls.add(entry.url));
    } catch (error) {
      console.error(`Error reading ${file}:`, error.message);
    }
  }
  return existingUrls;
};

// Scrape products with infinite scroll
const scrapeInfiniteScrollPage = async (
  page,
  baseUrl,
  processedUrls,
  productDataArray,
  outputFileName,
  retries = 3
) => {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await page.setUserAgent(getRandomUserAgent());
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        Referer: "https://www.farmasi.com.tr/",
        "Upgrade-Insecure-Requests": "1",
      });

      logProgress("PAGE_SCRAPING", `Navigating to: ${baseUrl}`);
      await page.goto(baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      });

      try {
        await page.waitForSelector(".cc-nb-okagree", { timeout: 5000 });
        await page.click(".cc-nb-okagree");
        logProgress("PAGE_SCRAPING", "Accepted all cookies");
        await delay(1000);
      } catch (e) {
        logProgress(
          "PAGE_SCRAPING",
          "No cookie popup found or failed to click: " + e.message
        );
      }

      await page.waitForSelector(".col-lg-3.col-xs-6", { timeout: 30000 });
      await simulateHumanBehavior(page);

      await scrollUntilNoMoreContent(page);

      const productUrls = await page.evaluate(() => {
        const productCards = document.querySelectorAll(".col-lg-3.col-xs-6");
        return Array.from(productCards)
          .map((card) => {
            const link = card.querySelector("a.detaillink");
            return link ? link.getAttribute("href") : null;
          })
          .filter((url) => url)
          .map((url) =>
            url.startsWith("http") ? url : `https://www.farmasi.com.tr${url}`
          );
      });

      logProgress("PAGE_SCRAPING", `Found ${productUrls.length} product URLs`);

      const productPage = await browser.newPage();
      await productPage.setUserAgent(getRandomUserAgent());
      await productPage.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        Referer: baseUrl,
        "Upgrade-Insecure-Requests": "1",
      });

      for (const url of productUrls) {
        if (processedUrls.has(url)) {
          logProgress(
            "PAGE_SCRAPING",
            `Skipping already processed URL: ${url}`
          );
          continue;
        }

        try {
          const productData = await scrapeProductDetails(productPage, url);
          productDataArray.push(productData);
          processedUrls.add(url);
          logProgress("PAGE_SCRAPING", `Scraped ${url} successfully`);
          saveUrlsToFile(productDataArray, outputFileName);
        } catch (error) {
          logProgress(
            "PAGE_SCRAPING",
            `Failed to scrape ${url}: ${error.message}`
          );
          productDataArray.push({
            url,
            productId: getProductIdFromUrl(url),
            title: "Failed to scrape",
            price: null,
            currency: "TL",
            images: "Image not found",
            rating: null,
            description: "Failed to scrape",
          });
          saveUrlsToFile(productDataArray, outputFileName);
        }
        await delay(Math.random() * 4000 + 3000);
      }

      await productPage.close();
      cleanupMemory(); // Clean up after processing all products
      break;
    } catch (error) {
      logProgress(
        "PAGE_SCRAPING",
        `Attempt ${attempt + 1} failed: ${error.message}`
      );
      if (attempt === retries - 1) {
        logProgress("PAGE_SCRAPING", "Max retries reached. Moving on.");
        break;
      }
      await page.close();
      page = await browser.newPage();
      await delay(5000);
    }
  }
};

// Main scraping function
const scrapeFarmasiProducts = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node scraper.js <url>");
    process.exit(1);
  }

  try {
    browser = await launchBrowser();

    const farmasiDir = path.join(outputDir, "farmasi");
    if (!fs.existsSync(farmasiDir)) {
      fs.mkdirSync(farmasiDir, { recursive: true });
    }

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing URL: ${baseUrl}`);
      let processedUrls = loadExistingUrls(baseUrl, farmasiDir);
      let productDataArray = [];

      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];
      const outputFileName = path.join(
        farmasiDir,
        `products_${dateStr}_${urlSlug}_${timestamp}.json`
      );

      if (fs.existsSync(outputFileName)) {
        try {
          const existingData = fs.readFileSync(outputFileName, "utf8");
          productDataArray = JSON.parse(existingData);
          logProgress(
            "MAIN",
            `Loaded ${productDataArray.length} existing entries from ${outputFileName}`
          );
        } catch (error) {
          console.error(
            `Error reading existing file ${outputFileName}:`,
            error.message
          );
        }
      }

      let page = await browser.newPage();
      try {
        await scrapeInfiniteScrollPage(
          page,
          baseUrl,
          processedUrls,
          productDataArray,
          outputFileName
        );
      } finally {
        await page.close();
        cleanupMemory(); // Clean up after page processing
      }

      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productDataArray.length} entries saved to ${outputFileName}`
      );
    }
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
  } finally {
    if (browser) {
      await browser.close();
      logProgress("MAIN", "Browser closed");
      cleanupMemory(); // Final cleanup
    }
    process.exit(0);
  }
};

scrapeFarmasiProducts();
