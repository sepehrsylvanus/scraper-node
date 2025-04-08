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
      if (browser && browser.isConnected()) {
        logProgress("BROWSER", "Closing existing browser instance...");
        await browser.close();
        logProgress("BROWSER", "Existing browser instance closed");
        triggerGC();
        await delay(2000);
      }
      logProgress("BROWSER", `Launching browser (attempt ${i + 1})...`);
      browser = await puppeteer.launch({
        headless: true,
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

// Extract product URLs with improved logic
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting with base URL: ${baseUrl}`);
  let allProductUrls = new Set();
  let retryCount = 0;
  const maxRetries = 5;

  await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 120000 });

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

  try {
    await page.evaluate(async () => {
      const seeMoreButton = document.querySelector(
        "button.see-more-button[data-js-infinitescroll-see-more]"
      );
      if (seeMoreButton) {
        seeMoreButton.scrollIntoView({ behavior: "smooth", block: "center" });
        await new Promise((resolve) => setTimeout(resolve, 500));
        seeMoreButton.click();
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    });
    logProgress("URL_COLLECTION", "Initial scroll and button click completed");
  } catch (error) {
    logProgress(
      "URL_COLLECTION",
      "Error with initial button handling: " + error.message
    );
  }

  let previousProductCount = 0;
  let noNewProductsTime = 0;
  const maxNoNewProductsTime = 10000;
  const scrollStep = 500;
  const minProductsToCollect = totalProducts;

  while (!shouldStop && allProductUrls.size < minProductsToCollect) {
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

    const previousSize = allProductUrls.size;
    currentUrls.forEach((url) => allProductUrls.add(url));

    logProgress(
      "URL_COLLECTION",
      `Progress: ${allProductUrls.size}/${totalProducts} unique URLs collected`
    );

    const footerVisible = await page.evaluate(() => {
      const footer = document.querySelector(
        ".content-asset.footer-reinssurance"
      );
      if (footer) {
        const rect = footer.getBoundingClientRect();
        return (
          rect.top >= 0 &&
          rect.bottom <=
            (window.innerHeight || document.documentElement.clientHeight)
        );
      }
      return false;
    });

    if (allProductUrls.size === previousProductCount) {
      noNewProductsTime += 1000;
      if (noNewProductsTime >= maxNoNewProductsTime) {
        logProgress(
          "URL_COLLECTION",
          `No new products for 10 seconds. Current count: ${allProductUrls.size}/${totalProducts}`
        );
        if (
          allProductUrls.size < minProductsToCollect &&
          retryCount < maxRetries
        ) {
          retryCount++;
          logProgress(
            "URL_COLLECTION",
            `Retry ${retryCount}/${maxRetries}: Resetting scroll and waiting for load`
          );
          await page.evaluate(async (step) => {
            window.scrollTo({ top: 0, behavior: "smooth" });
            await new Promise((resolve) => setTimeout(resolve, 2000));
            let currentPosition = 0;
            const maxHeight = document.body.scrollHeight;
            while (currentPosition < maxHeight) {
              window.scrollBy(0, step);
              currentPosition += step;
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          }, scrollStep);
          await delay(5000);
          noNewProductsTime = 0;
        } else {
          logProgress(
            "URL_COLLECTION",
            `Max retries exhausted or sufficient products collected. Proceeding with ${allProductUrls.size} products`
          );
          break;
        }
      }
    } else {
      noNewProductsTime = 0;
      previousProductCount = allProductUrls.size;
    }

    if (footerVisible && allProductUrls.size < minProductsToCollect) {
      retryCount++;
      if (retryCount >= maxRetries) {
        logProgress(
          "URL_COLLECTION",
          `Max retries reached with footer visible. Proceeding with ${allProductUrls.size} products`
        );
        break;
      }
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "smooth" })
      );
      await delay(5000);
      continue;
    }

    await page.evaluate((step) => window.scrollBy(0, step), scrollStep);
    await delay(1000);
  }

  logProgress(
    "URL_COLLECTION",
    `Collected ${allProductUrls.size}/${totalProducts} products`
  );
  return Array.from(allProductUrls);
};

// Scrape product details with retry logic and navigation timeout handling
const scrapeProductDetails = async (
  page,
  url,
  browserInstance,
  maxRetries = 5
) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  let attempt = 0;
  let newPage = page;

  while (attempt < maxRetries) {
    try {
      await newPage.goto(url, { waitUntil: "networkidle2", timeout: 120000 });

      const productData = await newPage.evaluate((url) => {
        const productIdMatch = url.match(/P(\d+)/);
        const productId = productIdMatch ? productIdMatch[1] : "";

        const priceElement = document.querySelector(
          ".price-sales.price-sales-standard"
        );
        const priceText = priceElement ? priceElement.textContent.trim() : "";
        const priceMatch = priceText.match(/([\d.,]+)/);
        const price = priceMatch
          ? parseFloat(priceMatch[1].replace(".", "").replace(",", "."))
          : null;

        const ratingElement = document.querySelector(".bv-overall-score");
        const rating = ratingElement
          ? ratingElement.textContent.trim().split("/")[0]
          : null;

        const specificationsElement = document.querySelector(".specification");
        const specifications = specificationsElement
          ? Array.from(specificationsElement.querySelectorAll("li")).map(
              (spec) => ({
                name: spec.querySelector(".name").textContent.trim(),
                value: spec.querySelector(".value").textContent.trim(),
              })
            )
          : [];

        const breadcrumbElement = document.querySelector(
          ".breadcrumb.pdp-breadcrumb"
        );
        const breadcrumbItems = breadcrumbElement
          ? Array.from(
              breadcrumbElement.querySelectorAll(".breadcrumb-element")
            )
          : [];
        const categories = breadcrumbItems
          .slice(0, -1)
          .map((item) => item.querySelector("a").textContent.trim())
          .join(" > ");

        const titleElement = document.querySelector(".product-name");
        const title = titleElement ? titleElement.textContent.trim() : "";

        const brandElement = document.querySelector(".brand-name");
        const brand = brandElement ? brandElement.textContent.trim() : "";

        const descriptionElement = document.querySelector(
          ".description-content.product-description-box"
        );
        const description = descriptionElement
          ? descriptionElement.innerHTML
          : "";

        const readMoreLink = document.querySelector(
          ".read-more-pdp-description"
        );
        if (readMoreLink) {
          readMoreLink.click();
          return new Promise((resolve) => {
            setTimeout(() => {
              const expandedDescription = document.querySelector(
                ".description-ellipsis-wrapper"
              );
              resolve({
                productId,
                brand,
                title,
                price,
                rating,
                specifications,
                categories,
                description: expandedDescription
                  ? expandedDescription.innerHTML
                  : description,
              });
            }, 1000);
          });
        } else {
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
        }
      }, url);

      return productData;
    } catch (error) {
      attempt++;
      logProgress(
        "PRODUCT_SCRAPING",
        `Attempt ${attempt}/${maxRetries} failed for ${url}: ${error.message}`
      );

      if (
        error.name === "TimeoutError" &&
        error.message.includes("Navigation timeout")
      ) {
        logProgress(
          "PRODUCT_SCRAPING",
          `Navigation timeout detected. Closing page and retrying ${url}...`
        );
        await newPage.close();
        triggerGC();
        newPage = await browserInstance.newPage();
        await newPage.setViewport({ width: 1366, height: 768 });
        await newPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );
        await delay(3000);
      } else if (attempt === maxRetries) {
        throw error;
      } else {
        await delay(2000);
        await newPage.reload({ waitUntil: "networkidle2", timeout: 120000 });
      }
    }
  }
};

// Save data to file
const saveUrlsToFile = (data, filePath) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  logProgress("FILE", `Saved ${data.length} product entries to ${filePath}`);
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
    const productsPerBrowserRestart = 100; // Reduced to 100 for more frequent restarts

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
      await page.setViewport({ width: 1366, height: 768 });
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      const productUrls = await extractProductUrls(page, baseUrl);
      await page.close();
      triggerGC();
      logProgress("MAIN", "Closed initial page after URL extraction");

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
          if (browser && browser.isConnected()) {
            await browser.close();
            logProgress("MAIN", "Old browser instance closed");
            triggerGC();
          }
          await delay(3000);
          browser = await launchBrowser();
          logProgress("MAIN", "New browser instance launched");
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
          productData.url = url;
          productDataArray.push(productData);
          logProgress(
            "MAIN",
            `Scraped details for ${url}: Price=${productData.price}, Rating=${productData.rating}`
          );
          saveUrlsToFile(productDataArray, outputFileName);
        } catch (error) {
          console.error(`Failed to scrape ${url} after retries:`, error);
          productDataArray.push({
            url,
            productId: "",
            brand: "",
            title: "",
            price: null,
            currency: "TRY",
            images: "",
            rating: null,
            specifications: [],
            categories: "",
            description: "",
            error: error.message,
          });
          saveUrlsToFile(productDataArray, outputFileName);
        }

        await productPage.close();
        triggerGC();
        logProgress(
          "MAIN",
          `Closed product page for ${url}. Waiting 4 seconds before next product...`
        );
        await delay(4000); // Increased to 4 seconds
        productCount++;
        logMemoryUsage();
      }

      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productDataArray.length} entries saved to ${outputFileName}`
      );
    }
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
  } finally {
    if (browser && browser.isConnected()) {
      logProgress("MAIN", "Closing browser in finally block...");
      await browser.close();
      triggerGC();
      logProgress("MAIN", "Browser closed");
    }
    process.exit(0);
  }
};

// Enable garbage collection check
if (typeof global.gc === "undefined") {
  console.log(
    "Run with --expose-gc to enable manual garbage collection: node --expose-gc sephora.js <url>"
  );
}

scrapeSephoraUrls();
