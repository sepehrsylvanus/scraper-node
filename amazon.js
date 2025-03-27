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

// Extract product URLs from Amazon search results page
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting with base URL: ${baseUrl}`);
  let allProductUrls = new Set();
  let currentPage = 1;

  while (!shouldStop) {
    const currentUrl =
      currentPage === 1 ? baseUrl : `${baseUrl}&page=${currentPage}`;
    logProgress(
      "URL_COLLECTION",
      `Navigating to page ${currentPage}: ${currentUrl}`
    );
    await page.goto(currentUrl, { waitUntil: "networkidle2", timeout: 60000 });

    const currentUrls = await page.evaluate(() => {
      const productElements = document.querySelectorAll(
        ".s-result-item.s-asin .s-product-image-container a.a-link-normal"
      );
      return Array.from(productElements)
        .map((element) => element.getAttribute("href"))
        .filter((url) => url && !url.includes("javascript:"));
    });

    currentUrls.forEach((url) => {
      const absoluteUrl = url.startsWith("http")
        ? url
        : new URL(url, "https://www.amazon.com.tr").href;
      allProductUrls.add(absoluteUrl);
    });

    logProgress(
      "URL_COLLECTION",
      `Found ${allProductUrls.size} unique URLs so far...`
    );

    // Check for next page
    const nextButton = await page.$(
      ".s-pagination-container .s-pagination-next:not(.s-pagination-disabled)"
    );
    if (!nextButton) {
      logProgress(
        "URL_COLLECTION",
        "No enabled 'Next' button found. Stopping."
      );
      break;
    }

    const isLastPage = await page.evaluate(() => {
      const nextButton = document.querySelector(
        ".s-pagination-container .s-pagination-next"
      );
      return nextButton.classList.contains("s-pagination-disabled");
    });

    if (isLastPage) {
      logProgress("URL_COLLECTION", "Reached last page. Stopping.");
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

  try {
    await page.waitForSelector("#acrPopover", { timeout: 10000 });
    logProgress("PRODUCT_SCRAPING", "Rating section found.");
  } catch (error) {
    logProgress("PRODUCT_SCRAPING", "Rating section not found.");
  }

  try {
    await page.waitForSelector("#productDetails_techSpec_section_1", {
      timeout: 10000,
    });
    logProgress("PRODUCT_SCRAPING", "Specifications table found.");
  } catch (error) {
    logProgress("PRODUCT_SCRAPING", "Specifications table not found.");
  }

  try {
    await page.waitForSelector("#feature-bullets", { timeout: 10000 });
    logProgress("PRODUCT_SCRAPING", "Feature bullets section found.");
  } catch (error) {
    logProgress("PRODUCT_SCRAPING", "Feature bullets section not found.");
  }

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
      const priceString = `${wholePriceText}.${fractionPrice}`;
      price = parseFloat(priceString);
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

  const productIdMatch = url.match(/\/dp\/([A-Z0-9]{10})/);
  productData.productId = productIdMatch
    ? productIdMatch[1]
    : productData.productId;

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
const scrapeAmazonUrls = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node script.js <url1> <url2> ...");
    process.exit(1);
  }

  try {
    const amazonDir = path.join(outputDir, "amazon");
    if (!fs.existsSync(amazonDir)) fs.mkdirSync(amazonDir, { recursive: true });

    const browser = await launchBrowser();

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing base URL: ${baseUrl}`);
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

scrapeAmazonUrls();
