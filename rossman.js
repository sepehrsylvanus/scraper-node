const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

let browser;
let shouldStop = false;

const today = new Date("2025-03-19");
const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
  2,
  "0"
)}-${String(today.getDate()).padStart(2, "0")}`;

// Utility to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Custom logging function for immediate output
const logProgress = (level, message) => {
  process.stdout.write(`[${new Date().toISOString()}] [${level}] ${message}\n`);
};

// Launch browser with retry logic
const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (browser && browser.isConnected()) return browser;
      logProgress("BROWSER", `Launching browser (attempt ${i + 1})...`);
      browser = await puppeteer.launch({
        headless: false, // Set to true for production
        protocolTimeout: 86400000,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      logProgress("BROWSER", "Browser launched successfully.");
      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await delay(2000);
    }
  }
};

// Scroll page and extract product URLs
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting scrape for: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 60000 });

  const totalProducts = await page.evaluate(() => {
    const amountElement = document.querySelector(
      "#product-amount .toolbar-amount"
    );
    return amountElement
      ? parseInt(amountElement.textContent.replace(/[^\d]/g, ""), 10)
      : 0;
  });
  logProgress("URL_COLLECTION", `Total products expected: ${totalProducts}`);

  let allProductUrls = new Set();
  let previousHeight;

  while (!shouldStop) {
    const currentUrls = await page.evaluate(() => {
      const productElements = document.querySelectorAll(
        ".product-item-detail-link"
      );
      return Array.from(productElements)
        .map((element) => element.getAttribute("href"))
        .filter((url) => url && !url.includes("javascript:"));
    });

    currentUrls.forEach((url) => {
      const absoluteUrl = url.startsWith("http")
        ? url
        : new URL(url, baseUrl).href;
      allProductUrls.add(absoluteUrl);
    });

    logProgress(
      "URL_COLLECTION",
      `Found ${allProductUrls.size} unique URLs so far...`
    );

    if (allProductUrls.size >= totalProducts) {
      logProgress("URL_COLLECTION", `Collected all ${totalProducts} products.`);
      break;
    }

    previousHeight = await page.evaluate("document.body.scrollHeight");
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    await delay(3000);

    const newHeight = await page.evaluate("document.body.scrollHeight");
    if (newHeight === previousHeight) {
      logProgress(
        "URL_COLLECTION",
        "No more products loaded. Stopping scroll."
      );
      break;
    }
  }

  return { productUrls: Array.from(allProductUrls), totalProducts };
};

// Scrape individual product details with retries
const scrapeProductDetails = async (page, url, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      logProgress(
        "PRODUCT_SCRAPE",
        `Scraping product: ${url} (attempt ${i + 1})`
      );
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await delay(3000);

      await page.evaluate(() => {
        const descTab = document.querySelector(
          'a[data-toggle="trigger"][href="#description"]'
        );
        if (descTab) descTab.click();
      });
      await delay(1000);

      const details = await page.evaluate((pageUrl) => {
        const absoluteUrl = pageUrl;
        const title =
          document.querySelector(".product-name1")?.textContent.trim() || null;
        const brand =
          document
            .querySelector(".product-brand-name")
            ?.childNodes[0].textContent.trim() || null;

        const priceText =
          document.querySelector(".final-price")?.textContent.trim() || "0 TL";
        const priceMatch = priceText.match(/([\d,]+)\s*(\w+)/);
        const price = priceMatch
          ? parseFloat(priceMatch[1].replace(",", "."))
          : 0;
        const currency = priceMatch ? priceMatch[2] : "TL";

        const imageElements = document.querySelectorAll(
          '.gallery-placeholder a[data-fancybox="gallery"]'
        );
        const images =
          Array.from(imageElements)
            .map((img) => img.getAttribute("href"))
            .filter((src) => src)
            .join(";") || null;

        const rating = null;
        const shippingFee = null;

        const descriptionElement = document.querySelector(
          ".product.attribute.description .value"
        );
        const description = descriptionElement
          ? descriptionElement.innerHTML.trim()
          : null;

        const specifications = null;

        // Updated category extraction from breadcrumbs, excluding the last item (product name)
        const categoryElements = document.querySelectorAll(
          ".breadcrumbs .items .item:not(:last-child) a"
        );
        const categories = Array.from(categoryElements)
          .map((el) => el.textContent.trim())
          .join(">");
        const formattedCategories = categories || null;

        // Updated regex to match both "sr" and "st" (or any two-letter prefix) followed by digits
        const productIdMatch = pageUrl.match(/p-([a-z]{2}\d+)/);
        const productId = productIdMatch ? productIdMatch[1] : null;

        return {
          url: absoluteUrl,
          title,
          brand,
          price,
          currency,
          images,
          rating,
          shipping_fee: shippingFee,
          description,
          specifications,
          categories: formattedCategories,
          productId,
        };
      }, url);

      logProgress("PRODUCT_SCRAPE", `Successfully scraped: ${url}`);
      return details;
    } catch (error) {
      console.error(
        `[PRODUCT_SCRAPE] Attempt ${i + 1} failed for ${url}:`,
        error.message
      );
      if (i === retries - 1) {
        logProgress(
          "PRODUCT_SCRAPE",
          `Failed after ${retries} attempts for ${url}`
        );
        return {
          url,
          title: null,
          brand: null,
          price: 0,
          currency: null,
          images: null,
          rating: null,
          shipping_fee: null,
          description: null,
          specifications: null,
          categories: null,
          productId: null,
          error: error.message,
        };
      }
      await delay(5000);
    }
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
      const data = fs.readFileSync(path.join(dir, file), "utf8");
      const products = JSON.parse(data);
      products.forEach(
        (product) => product.url && existingProducts.add(product.url)
      );
    } catch (error) {
      console.error(`Error reading ${file}:`, error.message);
    }
  }
  logProgress(
    "FILE",
    `Loaded ${existingProducts.size} existing products for ${baseUrl}`
  );
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
    const rossmannDir = path.join(outputDir, "rossmann");
    if (!fs.existsSync(rossmannDir))
      fs.mkdirSync(rossmannDir, { recursive: true });

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing: ${baseUrl}`);
      let processedUrls = loadExistingProducts(baseUrl, rossmannDir);
      let productsArray = [];

      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];
      const outputFileName = path.join(
        rossmannDir,
        `products_${dateStr}_${urlSlug}_${timestamp}.json`
      );
      saveProductsToFile(productsArray, outputFileName);

      await launchBrowser();
      const mainPage = await browser.newPage();
      await mainPage.setViewport({ width: 1366, height: 768 });
      await mainPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      const { productUrls, totalProducts } = await extractProductUrls(
        mainPage,
        baseUrl
      );
      await mainPage.close();

      logProgress(
        "MAIN",
        `Found ${productUrls.length} product URLs out of ${totalProducts}`
      );

      for (let i = 0; i < productUrls.length; i++) {
        const productUrl = productUrls[i];
        if (processedUrls.has(productUrl)) {
          logProgress("PRODUCT_SKIP", `Skipping processed URL: ${productUrl}`);
          continue;
        }

        const productPage = await browser.newPage();
        try {
          const details = await scrapeProductDetails(productPage, productUrl);
          productsArray.push(details);
          processedUrls.add(productUrl);
          saveProductsToFile(productsArray, outputFileName);
          logProgress(
            "MAIN",
            `Progress: ${productsArray.length}/${totalProducts} - Saved ${productUrl}`
          );
        } catch (error) {
          console.error(`[MAIN] Failed to scrape ${productUrl}:`, error);
        } finally {
          await productPage.close();
        }
        await delay(2000);
      }

      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${processedUrls.size}/${totalProducts} products saved to ${outputFileName}`
      );
    }

    logProgress("MAIN", "All URLs processed.");
    if (browser) {
      await browser.close();
      logProgress("BROWSER", "Browser closed successfully.");
    }
    process.exit(0);
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
    if (browser) {
      await browser.close();
      logProgress("BROWSER", "Browser closed due to error.");
    }
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on("SIGINT", async () => {
  logProgress("SHUTDOWN", "Shutting down...");
  shouldStop = true;
  if (browser) {
    await browser.close();
    logProgress("BROWSER", "Browser closed on shutdown.");
  }
  process.exit(0);
});

// Start the scraping process
scrapeMultipleUrls();
