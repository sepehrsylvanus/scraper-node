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

// Extract product URLs with infinite scroll and total products check
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
    const totalElement = document.querySelector(".products-length strong");
    return totalElement ? parseInt(totalElement.textContent.trim(), 10) : 0;
  });
  logProgress("URL_COLLECTION", `Total products expected: ${totalProducts}`);

  let noNewUrlsCount = 0;
  const maxNoNewUrls = 3;

  while (!shouldStop && allProductUrls.size < totalProducts) {
    try {
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

      await page
        .waitForSelector(".product-card_container a.product-card_header", {
          timeout: 10000,
        })
        .catch(() => {});

      const currentUrls = await page.evaluate(() => {
        const productLinks = document.querySelectorAll(
          ".product-card_container a.product-card_header"
        );
        return Array.from(productLinks)
          .map((link) => {
            const href = link.getAttribute("href");
            if (href && href.startsWith("/")) {
              return `https://www.yvesrocher.com.tr${href}`;
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

      const loaderVisible = await page.evaluate(() => {
        const loader = document.querySelector(".loading-spinner");
        return loader && loader.offsetParent !== null;
      });

      if (allProductUrls.size === previousSize && !loaderVisible) {
        noNewUrlsCount++;
        logProgress(
          "URL_COLLECTION",
          `No new URLs or loader found (streak: ${noNewUrlsCount}/${maxNoNewUrls})`
        );
        if (noNewUrlsCount >= maxNoNewUrls) {
          logProgress(
            "URL_COLLECTION",
            "No new URLs or loader after multiple scrolls, ending scroll"
          );
          break;
        }
      } else if (allProductUrls.size === previousSize && loaderVisible) {
        logProgress(
          "URL_COLLECTION",
          "Loader visible, waiting for new products..."
        );
        await delay(5000);
        noNewUrlsCount = 0;
      } else {
        noNewUrlsCount = 0;
      }

      if (allProductUrls.size >= totalProducts) {
        logProgress(
          "URL_COLLECTION",
          "Reached or exceeded expected product count, stopping"
        );
        break;
      }

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

      // Extract variant elements
      const variantElements = await page.$$(
        ".slider_pagination-color-variant .pagination_content-unit [data-js='img-selector']"
      );
      let imageUrls = [];

      if (variantElements.length > 0) {
        for (const variant of variantElements) {
          await variant.click();
          await delay(1000); // Wait for the slider image to update

          const imageSrc = await page.evaluate(() => {
            const img = document.querySelector(".slider-single .picture_image");
            return img ? img.getAttribute("src") : null;
          });

          if (imageSrc && !imageUrls.includes(imageSrc)) {
            imageUrls.push(imageSrc);
          }
        }
      } else {
        const fallbackImage = await page.evaluate(() => {
          const img = document.querySelector(".slider-single .picture_image");
          return img ? img.getAttribute("src") : null;
        });
        if (fallbackImage) imageUrls.push(fallbackImage);
      }

      // Scroll to reviews section and open accordion
      let rating = null;
      try {
        await page.waitForSelector("#BVRRSection", { timeout: 10000 });
        await page.evaluate(() => {
          const reviewsSection = document.querySelector("#BVRRSection");
          if (reviewsSection) {
            reviewsSection.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
          }
        });
        await delay(2000); // Wait for scroll

        // Check if accordion is collapsed and open it
        const isAccordionCollapsed = await page.evaluate(() => {
          const summary = document.querySelector(
            "#BVRRSection summary[data-js-summary-accordeon='summary']"
          );
          if (summary) {
            const isCollapsed =
              !summary.parentElement.classList.contains("open");
            if (isCollapsed) summary.click();
            return isCollapsed;
          }
          return false;
        });

        if (isAccordionCollapsed) {
          await delay(3000); // Wait for accordion to open
        }

        // Wait for rating element and extract
        await page.waitForSelector(".bv-rating-ratio-number .bv-rating", {
          timeout: 10000,
        });
        rating = await page.evaluate(() => {
          const ratingElement = document.querySelector(
            ".bv-rating-ratio-number .bv-rating span[aria-hidden='true']"
          );
          return ratingElement ? ratingElement.textContent.trim() : null;
        });
        logProgress(
          "PRODUCT_SCRAPING",
          `Extracted rating: ${rating || "None"}`
        );
      } catch (error) {
        logProgress(
          "PRODUCT_SCRAPING",
          `Failed to extract rating: ${error.message}`
        );
      }

      const productData = await page.evaluate(
        (url, imageUrls, rating) => {
          const brand = "Yves Rocher";

          const titleElement = document.querySelector("h1.text_XXXL");
          const title = titleElement ? titleElement.textContent.trim() : "";

          const priceElement = document.querySelector(
            ".product-card_price-block .bold"
          );
          const price = priceElement
            ? parseFloat(
                priceElement.textContent
                  .replace(/[^\d.,]/g, "")
                  .replace(",", ".")
              )
            : null;

          const currency = "TL";

          const images = imageUrls.length > 0 ? imageUrls.join(";") : "";

          const descriptionElement = document.querySelector(
            ".custom-summary-description .text_S p"
          );
          const description = descriptionElement
            ? descriptionElement.innerHTML.trim()
            : "";

          const productIdMatch = url.match(/\/p\/(\d+)\/?$/);
          const productId = productIdMatch ? productIdMatch[1] : "";

          const breadcrumbElements = document.querySelectorAll(
            "#breadcrumbs li a.link"
          );
          const categories = Array.from(breadcrumbElements)
            .map((el) => el.textContent.trim())
            .filter((cat) => cat && cat !== "Anasayfa");
          const categoryString = categories.join(">");

          return {
            brand,
            title,
            price,
            currency,
            images,
            description,
            productId,
            url,
            categories: categoryString,
            rating,
          };
        },
        url,
        imageUrls,
        rating
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
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node --expose-gc script.js <url1> <url2> ...");
    process.exit(1);
  }

  try {
    const siteDir = path.join(outputDir, "yvesrocher");
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
          if (productData) {
            productDataArray.push(productData);
            saveUrlsToFile(productDataArray, outputFileName);
          }
        } catch (error) {
          logProgress("MAIN", `Failed to scrape ${url}: ${error.message}`);
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
    "Run with --expose-gc to enable manual garbage collection: node --expose-gc script.js <url>"
  );
}

scrapeWebsite();
