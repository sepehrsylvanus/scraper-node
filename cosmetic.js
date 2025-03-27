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

// Launch browser with retry logic
const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (browser && browser.isConnected()) return browser;
      logProgress("BROWSER", `Launching browser (attempt ${i + 1})...`);
      browser = await puppeteer.launch({
        headless: false, // Set to true for production
        protocolTimeout: 86400000, // 24-hour timeout
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await delay(2000);
    }
  }
};

// Extract product URLs from the cosmetic website listing page
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting with base URL: ${baseUrl}`);
  let allProductUrls = new Set();
  let currentPage = 1;

  while (!shouldStop) {
    const currentUrl =
      currentPage === 1 ? baseUrl : `${baseUrl}?page=${currentPage}`;
    logProgress(
      "URL_COLLECTION",
      `Navigating to page ${currentPage}: ${currentUrl}`
    );
    await page.goto(currentUrl, { waitUntil: "networkidle2", timeout: 60000 });

    const currentUrls = await page.evaluate(() => {
      const productElements = document.querySelectorAll(
        "a.flex.h-full.w-full.grow.flex-col.overflow-hidden.rounded.rounded-b-none.border.border-b-0.border-neutral-300\\/70"
      );
      return Array.from(productElements)
        .map((element) => element.getAttribute("href"))
        .filter((url) => url && !url.includes("javascript:"));
    });

    currentUrls.forEach((url) => {
      const absoluteUrl = url.startsWith("http")
        ? url
        : new URL(url, "https://www.cosmetica.com.tr").href;
      allProductUrls.add(absoluteUrl);
    });

    logProgress(
      "URL_COLLECTION",
      `Found ${allProductUrls.size} unique URLs so far...`
    );

    // Check for next page (assuming a common pagination class or button)
    const nextButton = await page.$("button.next-page:not(.disabled)"); // Adjust selector as needed
    if (!nextButton) {
      logProgress(
        "URL_COLLECTION",
        "No enabled 'Next' button found. Stopping."
      );
      break;
    }

    logProgress("URL_COLLECTION", `Moving to page ${currentPage + 1}...`);
    await nextButton.click();
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });
    currentPage++;
    await delay(2000); // Polite delay between page loads
  }

  return Array.from(allProductUrls);
};

// Scrape product details from individual product page
const scrapeProductDetails = async (page, url) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

  const productData = await page.evaluate(() => {
    const productContainer = document.querySelector(
      ".relative.flex.h-full.w-full.grow.flex-col.overflow-hidden"
    );
    if (!productContainer) return null;

    // Extract brand
    const brandElement = productContainer.querySelector(
      ".text-left.text-xs.font-bold.uppercase"
    );
    const brand = brandElement ? brandElement.textContent.trim() : "";

    // Extract title
    const titleElement = productContainer.querySelector(
      ".mb-1.mt-0\\.5.text-left.text-sm.font-semibold"
    );
    const title = titleElement ? titleElement.textContent.trim() : "";

    // Extract price and currency
    let price = null;
    let currency = "";
    const priceElement = productContainer.querySelector(
      ".text-base.font-semibold.\\!leading-none.text-button-01"
    );
    const originalPriceElement = productContainer.querySelector(
      ".pb-1.text-xs.font-medium.\\!leading-none.text-button-01\\/50.line-through"
    );
    if (priceElement) {
      const priceText = priceElement.textContent.trim();
      currency = priceText.match(/[^\d.,]+/)?.[0] || "₺";
      price = parseFloat(priceText.replace(/[^\d.,]/g, "").replace(",", "."));
    }
    const originalPrice = originalPriceElement
      ? parseFloat(
          originalPriceElement.textContent
            .trim()
            .replace(/[^\d.,]/g, "")
            .replace(",", ".")
        )
      : null;

    // Extract discount percentage
    const discountElement = productContainer.querySelector(
      ".flex.flex-col.items-center.justify-center.rounded.bg-button-02 span:nth-child(2)"
    );
    const discount = discountElement
      ? discountElement.textContent.trim().replace("%", "")
      : null;

    // Extract rating and review count
    let rating = null;
    let reviewCount = 0;
    const ratingContainer = productContainer.querySelector(
      ".mb-3\\.5.flex.items-center.gap-1.text-\\[10px\\].font-medium"
    );
    if (ratingContainer) {
      const stars = ratingContainer.querySelectorAll("svg");
      rating = stars.length > 0 ? stars.length : null; // Assuming filled stars indicate rating
      const reviewElement = ratingContainer.querySelector("span.opacity-50");
      reviewCount = reviewElement
        ? parseInt(reviewElement.textContent.trim().replace(/[()]/g, ""), 10)
        : 0;
    }

    // Extract image URLs
    const imageElements = productContainer.querySelectorAll("img");
    const images = Array.from(imageElements)
      .map((img) => img.getAttribute("src"))
      .filter((src) => src && src.includes("cdn.myikas.com"));

    return {
      url: window.location.href,
      brand,
      title,
      price,
      originalPrice,
      currency,
      discount,
      rating,
      reviewCount,
      images: images.join(";"),
    };
  });

  if (!productData) {
    return {
      url,
      brand: "",
      title: "",
      price: null,
      originalPrice: null,
      currency: "",
      discount: null,
      rating: null,
      reviewCount: 0,
      images: "",
    };
  }

  return {
    url: productData.url,
    brand: productData.brand,
    title: productData.title,
    price:
      productData.price !== null
        ? parseFloat(productData.price.toFixed(2))
        : null,
    originalPrice:
      productData.originalPrice !== null
        ? parseFloat(productData.originalPrice.toFixed(2))
        : null,
    currency: productData.currency,
    discount: productData.discount ? parseFloat(productData.discount) : null,
    rating: productData.rating,
    reviewCount: productData.reviewCount,
    images: productData.images || "",
  };
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
const scrapeCosmeticUrls = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node script.js <url1> <url2> ...");
    process.exit(1);
  }

  try {
    const cosmeticaDir = path.join(outputDir, "cosmetica");
    if (!fs.existsSync(cosmeticaDir))
      fs.mkdirSync(cosmeticaDir, { recursive: true });

    const browser = await launchBrowser();

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing base URL: ${baseUrl}`);
      let processedUrls = loadExistingUrls(baseUrl, cosmeticaDir);
      let productDataArray = [];

      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];
      const outputFileName = path.join(
        cosmeticaDir,
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

      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      // Collect all product URLs across pages
      const productUrls = await extractProductUrls(page, baseUrl);
      await page.close();

      logProgress(
        "MAIN",
        `Found ${productUrls.length} product URLs across all pages`
      );

      const productPage = await browser.newPage();
      await productPage.setViewport({ width: 1366, height: 768 });
      await productPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      for (const url of productUrls) {
        if (processedUrls.has(url)) {
          logProgress("MAIN", `Skipping already processed URL: ${url}`);
          continue;
        }

        try {
          const productData = await scrapeProductDetails(productPage, url);
          productDataArray.push(productData);
          logProgress(
            "MAIN",
            `Scraped details for ${url}: Price=${productData.price}, Currency=${productData.currency}`
          );
          saveUrlsToFile(productDataArray, outputFileName); // Save after each product
        } catch (error) {
          console.error(`Failed to scrape ${url}:`, error);
          productDataArray.push({
            url,
            brand: "",
            title: "",
            price: null,
            originalPrice: null,
            currency: "",
            discount: null,
            rating: null,
            reviewCount: 0,
            images: "",
          });
          saveUrlsToFile(productDataArray, outputFileName);
        }
        await delay(1000); // Polite delay
      }

      await productPage.close();

      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productDataArray.length} entries saved to ${outputFileName}`
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

scrapeCosmeticUrls();
