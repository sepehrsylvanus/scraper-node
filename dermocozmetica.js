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
        ],
        defaultViewport: { width: 1280, height: 800 },
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

// Scrape product details
const scrapeProductDetails = async (page, url, retries = 3) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await page.setUserAgent(getRandomUserAgent());
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        Referer: "https://www.dermokozmetika.com.tr/",
        "Upgrade-Insecure-Requests": "1",
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

      // Wait for and click the modal close button if it exists
      try {
        await page.waitForSelector("#closeModalButton", { timeout: 5000 });
        await page.click("#closeModalButton");
        logProgress("PRODUCT_SCRAPING", "Closed modal popup");
        await delay(1000); // Wait for modal to close
      } catch (e) {
        logProgress(
          "PRODUCT_SCRAPING",
          "No modal found or failed to close: " + e.message
        );
      }

      // Wait for the product title to ensure page is fully loaded
      await page.waitForSelector("#product-title", { timeout: 30000 });
      await simulateHumanBehavior(page);

      const productData = await page.evaluate(() => {
        const titleElement = document.querySelector("#product-title");
        const title = titleElement ? titleElement.textContent.trim() : "";

        const brandElement = document.querySelector(".w-100 a[href^='/']");
        const brand = brandElement
          ? brandElement.getAttribute("href").replace("/", "")
          : "";

        const priceElement = document.querySelector(
          ".product-current-price .product-price"
        );
        let price = null;
        if (priceElement) {
          const priceText = priceElement.textContent
            .trim()
            .replace(/[^0-9,]/g, "")
            .replace(",", ".");
          price = parseFloat(priceText);
        }

        const currencyElement = document.querySelector(
          ".product-current-price"
        );
        const currency = currencyElement
          ? currencyElement.textContent.trim().match(/TL/)?.[0] || "TL"
          : "TL";

        const imageElements = document.querySelectorAll(
          ".product-images-gallery img"
        );
        const images = Array.from(imageElements)
          .map((img) => img.getAttribute("src"))
          .filter((src) => src && !src.includes("placeholder.gif"));

        return { title, brand, price, currency, images };
      });

      return {
        url,
        title: productData.title || "",
        brand: productData.brand || "",
        price:
          productData.price !== null
            ? parseFloat(productData.price.toFixed(2))
            : null,
        currency: productData.currency || "TL",
        images: productData.images.length ? productData.images.join(";") : "",
        rating: null,
        reviewCount: 0,
        discount: "",
        features: [],
      };
    } catch (error) {
      logProgress(
        "PRODUCT_SCRAPING",
        `Attempt ${attempt + 1} failed: ${error.message}`
      );
      if (attempt === retries - 1) {
        return {
          url,
          title: "",
          brand: "",
          price: null,
          currency: "TL",
          images: "",
          rating: null,
          reviewCount: 0,
          discount: "",
          features: [],
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

// Scrape products page by page
const scrapePageByPage = async (
  page,
  baseUrl,
  processedUrls,
  productDataArray,
  outputFileName,
  retries = 3
) => {
  let currentPage = 1;
  const maxPages = 5;

  await page.setUserAgent(getRandomUserAgent());
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    Referer: "https://www.dermokozmetika.com.tr/",
    "Upgrade-Insecure-Requests": "1",
  });

  let currentUrl = baseUrl;
  while (currentPage <= maxPages && currentUrl) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        logProgress(
          "PAGE_SCRAPING",
          `Navigating to page ${currentPage}: ${currentUrl}`
        );
        await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: 90000,
        });
        await page.waitForSelector(".product-item", { timeout: 30000 });
        await simulateHumanBehavior(page);

        const { productUrls, nextPageUrl } = await page.evaluate(() => {
          const productCards = document.querySelectorAll(".product-item");
          const productUrls = Array.from(productCards)
            .map((card) => {
              const link = card.querySelector("a.image-wrapper");
              return link ? link.getAttribute("href") : null;
            })
            .filter((url) => url)
            .map((url) =>
              url.startsWith("http")
                ? url
                : `https://www.dermokozmetika.com.tr${url}`
            );

          const nextButton = document.querySelector(".pagination .next a");
          const nextPageUrl = nextButton
            ? `https://www.dermokozmetika.com.tr${nextButton.getAttribute(
                "href"
              )}`
            : null;

          return { productUrls, nextPageUrl };
        });

        logProgress(
          "PAGE_SCRAPING",
          `Found ${productUrls.length} product URLs on page ${currentPage}`
        );

        const productPage = await browser.newPage();
        await productPage.setUserAgent(getRandomUserAgent());
        await productPage.setExtraHTTPHeaders({
          "Accept-Language": "en-US,en;q=0.9",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          Referer: currentUrl,
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
              title: "",
              brand: "",
              price: null,
              currency: "TL",
              images: "",
              rating: null,
              reviewCount: 0,
              discount: "",
              features: [],
            });
            saveUrlsToFile(productDataArray, outputFileName);
          }
          await delay(Math.random() * 4000 + 3000);
        }

        await productPage.close();
        currentUrl = nextPageUrl;
        currentPage++;
        break;
      } catch (error) {
        logProgress(
          "PAGE_SCRAPING",
          `Attempt ${attempt + 1} failed for page ${currentPage}: ${
            error.message
          }`
        );
        if (attempt === retries - 1) {
          logProgress(
            "PAGE_SCRAPING",
            `Max retries reached for page ${currentPage}. Moving on.`
          );
          currentUrl = null;
          break;
        }
        await page.close();
        page = await browser.newPage();
        await page.setUserAgent(getRandomUserAgent());
        await page.setExtraHTTPHeaders({
          "Accept-Language": "en-US,en;q=0.9",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          Referer: "https://www.dermokozmetika.com.tr/",
          "Upgrade-Insecure-Requests": "1",
        });
        await delay(5000);
      }
    }

    if (currentUrl) {
      await delay(Math.random() * 10000 + 5000);
    }
  }
};

// Main scraping function
const scrapeDermokozmetikaProducts = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node scraper.js <url>");
    process.exit(1);
  }

  try {
    browser = await launchBrowser();

    const dermokozmetikaDir = path.join(outputDir, "dermokozmetika");
    if (!fs.existsSync(dermokozmetikaDir))
      fs.mkdirSync(dermokozmetikaDir, { recursive: true });

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing URL: ${baseUrl}`);
      let processedUrls = loadExistingUrls(baseUrl, dermokozmetikaDir);
      let productDataArray = [];

      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];
      const outputFileName = path.join(
        dermokozmetikaDir,
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
        await scrapePageByPage(
          page,
          baseUrl,
          processedUrls,
          productDataArray,
          outputFileName
        );
      } finally {
        await page.close();
      }

      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productDataArray.length} entries saved to ${outputFileName}`
      );
    }
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
  } finally {
    if (browser) await browser.close();
    logProgress("MAIN", "Browser closed");
    process.exit(0);
  }
};

scrapeDermokozmetikaProducts();
