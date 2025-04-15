const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

let browser;
let pagePool = []; // Track open pages
const MAX_MEMORY_MB = 2048; // Max memory threshold (2GB)
const MAX_PAGES = 5; // Max concurrent pages
const MEMORY_CHECK_INTERVAL = 30000; // Check memory every 30 seconds
const PAGE_IDLE_TIMEOUT = 60000; // Close pages idle for 60 seconds

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

// Randomize user-agent
const getRandomUserAgent = () => {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.96 Safari/537.36",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Load proxies from file
const loadProxies = () => {
  const proxyFile = path.join(outputDir, "proxies.json");
  if (fs.existsSync(proxyFile)) {
    try {
      const proxies = JSON.parse(fs.readFileSync(proxyFile, "utf8"));
      if (Array.isArray(proxies) && proxies.length > 0) {
        logProgress(
          "PROXY",
          `Loaded ${proxies.length} proxies from proxies.json`
        );
        return proxies;
      }
      logProgress("PROXY", "proxies.json is empty. Running without proxies.");
      return [];
    } catch (error) {
      logProgress(
        "PROXY",
        `Error reading proxies.json: ${error.message}. Running without proxies.`
      );
      return [];
    }
  }
  logProgress("PROXY", "No proxies.json found. Running without proxies.");
  return [];
};

// Garbage Collector
const startGarbageCollector = () => {
  setInterval(async () => {
    try {
      // Check memory usage
      const memoryUsage = process.memoryUsage().heapUsed / 1024 / 1024; // MB
      logProgress(
        "GARBAGE_COLLECTOR",
        `Memory usage: ${memoryUsage.toFixed(2)} MB`
      );

      if (memoryUsage > MAX_MEMORY_MB) {
        logProgress(
          "GARBAGE_COLLECTOR",
          "Memory threshold exceeded. Restarting browser..."
        );
        await cleanupBrowser();
        browser = await launchBrowser(loadProxies());
      }

      // Clean up idle pages
      const now = Date.now();
      pagePool = pagePool.filter((pageInfo) => {
        if (now - pageInfo.lastUsed > PAGE_IDLE_TIMEOUT) {
          logProgress("GARBAGE_COLLECTOR", `Closing idle page: ${pageInfo.id}`);
          pageInfo.page
            .close()
            .catch((err) =>
              logProgress(
                "GARBAGE_COLLECTOR",
                `Error closing page: ${err.message}`
              )
            );
          return false;
        }
        return true;
      });

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
        logProgress("GARBAGE_COLLECTOR", "Forced garbage collection");
      }
    } catch (error) {
      logProgress(
        "GARBAGE_COLLECTOR",
        `Error in garbage collector: ${error.message}`
      );
    }
  }, MEMORY_CHECK_INTERVAL);
};

// Cleanup browser and pages
const cleanupBrowser = async () => {
  try {
    if (browser && browser.isConnected()) {
      await Promise.all(
        pagePool.map((pageInfo) =>
          pageInfo.page
            .close()
            .catch((err) =>
              logProgress("BROWSER", `Error closing page: ${err.message}`)
            )
        )
      );
      pagePool = [];
      await browser.close();
      logProgress("BROWSER", "Browser closed for cleanup");
    }
  } catch (error) {
    logProgress("BROWSER", `Error during browser cleanup: ${error.message}`);
  }
};

// Get or create a page from pool
const getPage = async () => {
  if (pagePool.length >= MAX_PAGES) {
    const oldestPage = pagePool.shift();
    await oldestPage.page
      .close()
      .catch((err) =>
        logProgress("PAGE", `Error closing old page: ${err.message}`)
      );
  }

  const page = await browser.newPage();
  const pageId = `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await page.setUserAgent(getRandomUserAgent());
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  });

  pagePool.push({ id: pageId, page, lastUsed: Date.now() });
  return { page, id: pageId };
};

// Update page last used time
const updatePageUsage = (pageId) => {
  const pageInfo = pagePool.find((p) => p.id === pageId);
  if (pageInfo) pageInfo.lastUsed = Date.now();
};

// Launch browser with proxy and retry logic
const launchBrowser = async (proxies, retries = 3) => {
  const proxy = proxies.length
    ? proxies[Math.floor(Math.random() * proxies.length)]
    : null;
  for (let i = 0; i < retries; i++) {
    try {
      if (browser && browser.isConnected()) return browser;
      logProgress(
        "BROWSER",
        `Launching browser ${
          proxy ? `with proxy ${proxy}` : "without proxy"
        } (attempt ${i + 1})...`
      );

      const launchOptions = {
        headless: false,
        protocolTimeout: 86400000,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--start-maximized",
          "--disable-web-security",
          "--disable-features=IsolateOrigins,site-per-process",
        ],
        defaultViewport: null,
      };

      if (proxy) {
        launchOptions.args.push(`--proxy-server=${proxy}`);
      }

      browser = await puppeteer.launch(launchOptions);
      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await delay(1000);
    }
  }
};

// Scrape product details from individual product page
const scrapeProductDetails = async (page, pageId, url) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  updatePageUsage(pageId);

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    const productData = await page.evaluate(() => {
      let price = null;
      let currency = "";
      const wholePriceElement = document.querySelector("span.a-price-whole");
      const fractionPriceElement = document.querySelector(
        "span.a-price-fraction"
      );
      const currencyElement = document.querySelector("span.a-price-symbol");
      if (wholePriceElement && fractionPriceElement && currencyElement) {
        const wholePriceText = wholePriceElement.textContent.replace(
          /[^0-9]/g,
          ""
        );
        const fractionPrice = fractionPriceElement.textContent.padStart(2, "0");
        currency = currencyElement.textContent;
        price = parseFloat(`${wholePriceText}.${fractionPrice}`);
        if (price > 100) price = price / 1000;
      }

      const productIdMatch = window.location.href.match(/\/dp\/([A-Z0-9]{10})/);
      const productId = productIdMatch ? productIdMatch[1] : "";

      let brand = "";
      const techTableRows = document.querySelectorAll(
        "#productDetails_techSpec_section_1 tr"
      );
      for (const row of techTableRows) {
        const th = row.querySelector("th");
        const td = row.querySelector("td");
        if (th && td && th.textContent.trim() === "Marka Adı") {
          brand = td.textContent.trim().replace("‎", "");
          break;
        }
      }

      const titleElement = document.querySelector("#productTitle");
      const title = titleElement ? titleElement.textContent.trim() : "";

      const imageElements = document.querySelectorAll(
        "#altImages .imageThumbnail img"
      );
      const videoElements = document.querySelectorAll(
        "#altImages .videoThumbnail img"
      );
      let allImages = [];
      imageElements.forEach((img) => {
        const src = img.getAttribute("src");
        if (src && !allImages.includes(src)) allImages.push(src);
      });
      videoElements.forEach((videoImg) => {
        const src = videoImg.getAttribute("src");
        if (src && !allImages.includes(src)) allImages.push(src);
      });
      const imagesString = allImages.join(";");

      let rating = null;
      const ratingElement = document.querySelector(
        "#acrPopover .a-size-base.a-color-base"
      );
      if (ratingElement) {
        const ratingText = ratingElement.textContent.trim().replace(",", ".");
        rating = parseFloat(ratingText);
      }

      const specifications = [];
      const specRows = document.querySelectorAll(
        "#productDetails_techSpec_section_1 tr"
      );
      specRows.forEach((row) => {
        const nameElement = row.querySelector("th");
        const valueElement = row.querySelector("td");
        if (nameElement && valueElement) {
          const name = nameElement.textContent.trim();
          const value = valueElement.textContent.trim().replace("‎", "");
          specifications.push({ name, value });
        }
      });

      const categoryElements = document.querySelectorAll(
        "ul.a-unordered-list.a-horizontal .a-list-item a.a-link-normal"
      );
      const categories = Array.from(categoryElements)
        .map((el) => el.textContent.trim())
        .join(">");

      let description = "";
      const featureBullets = document.querySelector("#feature-bullets");
      if (featureBullets) {
        const listItems = featureBullets.querySelectorAll(
          "ul.a-unordered-list.a-vertical.a-spacing-mini li span.a-list-item"
        );
        description = Array.from(listItems)
          .map((item) => item.textContent.trim())
          .join("\n");
      }

      return {
        price,
        currency,
        productId,
        brand,
        title,
        images: imagesString,
        rating,
        specifications,
        categories,
        description,
      };
    });

    return {
      url,
      productId: productData.productId,
      brand: productData.brand,
      title: productData.title || "",
      price:
        productData.price !== null
          ? parseFloat(productData.price.toFixed(3))
          : null,
      currency: productData.currency,
      images: productData.images || "",
      rating: productData.rating !== null ? productData.rating : null,
      specifications: productData.specifications || [],
      categories: productData.categories || "",
      description: productData.description || "",
    };
  } catch (error) {
    logProgress("PRODUCT_SCRAPING", `Error scraping product: ${error.message}`);
    throw error;
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
  mainPage,
  mainPageId,
  baseUrl,
  processedUrls,
  productDataArray,
  outputFileName
) => {
  let currentPage = 1;
  const maxPages = 10;

  while (currentPage <= maxPages) {
    const currentUrl =
      currentPage === 1 ? baseUrl : `${baseUrl}&page=${currentPage}`;
    logProgress(
      "PAGE_SCRAPING",
      `Navigating to page ${currentPage}: ${currentUrl}`
    );

    try {
      await mainPage.goto(currentUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      updatePageUsage(mainPageId);
      await delay(2000);

      logProgress("PAGE_SCRAPING", `Loaded page ${currentPage}`);
      await mainPage.waitForSelector(".puis-card-container", {
        timeout: 10000,
      });
      logProgress("PAGE_SCRAPING", "Product cards loaded");

      const productUrls = await mainPage.evaluate(() => {
        const productCards = document.querySelectorAll(".puis-card-container");
        return Array.from(productCards)
          .map((card) => {
            const link = card.querySelector("a.a-link-normal.s-no-outline");
            return link ? link.getAttribute("href") : null;
          })
          .filter((url) => url && url.includes("/dp/"))
          .map((url) =>
            url.startsWith("http") ? url : `https://www.amazon.com.tr${url}`
          );
      });

      logProgress(
        "PAGE_SCRAPING",
        `Found ${productUrls.length} product URLs on page ${currentPage}`
      );

      for (const url of productUrls) {
        if (processedUrls.has(url)) {
          logProgress(
            "PAGE_SCRAPING",
            `Skipping already processed URL: ${url}`
          );
          continue;
        }

        const { page: productPage, id: productPageId } = await getPage();
        try {
          const productData = await scrapeProductDetails(
            productPage,
            productPageId,
            url
          );
          productDataArray.push(productData);
          logProgress(
            "PAGE_SCRAPING",
            `Scraped ${url}: Price=${productData.price}, Currency=${productData.currency}`
          );
          saveUrlsToFile(productDataArray, outputFileName);
          processedUrls.add(url);
        } catch (error) {
          logProgress(
            "PAGE_SCRAPING",
            `Failed to scrape ${url}: ${error.message}`
          );
          productDataArray.push({
            url,
            productId: "",
            brand: "",
            title: "",
            price: null,
            currency: "",
            images: "",
            rating: null,
            specifications: [],
            categories: "",
            description: "",
          });
          saveUrlsToFile(productDataArray, outputFileName);
        }
        await productPage.close();
        pagePool = pagePool.filter((p) => p.id !== productPageId);
        await delay(500);
      }

      let paginationLoaded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await mainPage.waitForSelector(
            "ul.a-unordered-list.a-horizontal.s-unordered-list-accessibility",
            { timeout: 5000 }
          );
          paginationLoaded = true;
          logProgress(
            "PAGE_SCRAPING",
            `Pagination loaded on attempt ${attempt + 1}`
          );
          break;
        } catch (error) {
          logProgress(
            "PAGE_SCRAPING",
            `Pagination not found on attempt ${attempt + 1}, retrying...`
          );
          await delay(1000);
          await mainPage.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight)
          );
        }
      }

      if (!paginationLoaded) {
        logProgress(
          "PAGE_SCRAPING",
          "Could not find pagination after multiple attempts"
        );
        break;
      }

      const nextPageUrl = await mainPage.evaluate(() => {
        const nextButton = document.querySelector(
          'a.s-pagination-item.s-pagination-next[aria-label^="Sonraki sayfaya git"]'
        );
        if (nextButton) {
          const href = nextButton.getAttribute("href");
          return href ? `https://www.amazon.com.tr${href}` : null;
        }
        return null;
      });

      if (!nextPageUrl) {
        logProgress(
          "PAGE_SCRAPING",
          "No next page button found. Stopping pagination."
        );
        break;
      }

      logProgress("PAGE_SCRAPING", `Moving to next page: ${nextPageUrl}`);
      currentPage++;
      await mainPage.goto(nextPageUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      updatePageUsage(mainPageId);
      await delay(2000);
    } catch (error) {
      logProgress(
        "PAGE_SCRAPING",
        `Error on page ${currentPage}: ${error.message}. Stopping.`
      );
      break;
    }
  }
};

// Main scraping function
const scrapeAmazonProducts = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node scraper.js <url>");
    process.exit(1);
  }

  try {
    const proxies = loadProxies();
    const amazonDir = path.join(outputDir, "amazon");
    if (!fs.existsSync(amazonDir)) fs.mkdirSync(amazonDir, { recursive: true });

    browser = await launchBrowser(proxies);
    startGarbageCollector(); // Start garbage collector

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing URL: ${baseUrl}`);
      let processedUrls = loadExistingUrls(baseUrl, amazonDir);
      let productDataArray = [];

      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];
      const outputFileName = path.join(
        amazonDir,
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

      const { page: mainPage, id: mainPageId } = await getPage();
      await scrapePageByPage(
        mainPage,
        mainPageId,
        baseUrl,
        processedUrls,
        productDataArray,
        outputFileName
      );
      await mainPage.close();
      pagePool = pagePool.filter((p) => p.id !== mainPageId);

      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productDataArray.length} entries saved to ${outputFileName}`
      );
    }

    await cleanupBrowser();
    logProgress("MAIN", "Browser closed");
    process.exit(0);
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
    await cleanupBrowser();
    process.exit(1);
  }
};

// Enable manual garbage collection if Node.js is run with --expose-gc
if (typeof global.gc === "undefined") {
  logProgress(
    "GARBAGE_COLLECTOR",
    "Garbage collection not exposed. Run Node.js with --expose-gc for better memory management."
  );
}

scrapeAmazonProducts();
