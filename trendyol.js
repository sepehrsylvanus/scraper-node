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
        headless: false, // Set to true for production if needed
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

// Extract product URLs from Trendyol listing page
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting scrape for: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 60000 });

  const totalProductsInfo = await page.evaluate(() => {
    const descElement = document.querySelector(".dscrptn.dscrptn-V2 h2");
    if (descElement) {
      const text = descElement.textContent.trim();
      const match = text.match(/([\d.]+)(\+)?\s+sonuç/);
      if (match) {
        const number = parseFloat(match[1].replace(".", ""));
        return { count: number, isPlus: !!match[2] };
      }
    }
    return { count: 0, isPlus: false };
  });

  const totalProducts = totalProductsInfo.count;
  const isIndeterminate = totalProductsInfo.isPlus;
  logProgress(
    "URL_COLLECTION",
    `Total products expected: ${totalProducts}${isIndeterminate ? "+" : ""}`
  );

  let allProductUrls = new Set();
  let previousHeight = 0;
  let stagnantCount = 0;
  const maxStagnantAttempts = 5;

  while (!shouldStop) {
    const currentUrls = await page.evaluate(() => {
      const productElements = document.querySelectorAll(
        ".p-card-chldrn-cntnr.card-border a"
      );
      return Array.from(productElements)
        .map((element) => element.getAttribute("href"))
        .filter((url) => url && !url.includes("javascript:"));
    });

    const previousSize = allProductUrls.size;
    currentUrls.forEach((url) => {
      const absoluteUrl = url.startsWith("http")
        ? url
        : new URL(url, "https://www.trendyol.com").href;
      allProductUrls.add(absoluteUrl);
    });

    logProgress(
      "URL_COLLECTION",
      `Found ${allProductUrls.size} unique URLs so far...`
    );

    if (!isIndeterminate && allProductUrls.size >= totalProducts) {
      logProgress(
        "URL_COLLECTION",
        `Collected sufficient products (${allProductUrls.size}/${totalProducts}).`
      );
      break;
    }

    await page.evaluate(() => window.scrollBy(0, 1000));
    await delay(2000);

    const currentHeight = await page.evaluate(() => document.body.scrollHeight);

    if (currentHeight === previousHeight) {
      stagnantCount++;
      logProgress(
        "URL_COLLECTION",
        `No height change detected (attempt ${stagnantCount}/${maxStagnantAttempts})`
      );
      if (stagnantCount >= maxStagnantAttempts) {
        logProgress(
          "URL_COLLECTION",
          `No new content after ${maxStagnantAttempts} attempts. Stopping at ${allProductUrls.size} URLs.`
        );
        break;
      }
    } else {
      stagnantCount = 0;
    }

    previousHeight = currentHeight;

    const atBottom = await page.evaluate(() => {
      return window.scrollY + window.innerHeight >= document.body.scrollHeight;
    });
    if (atBottom && allProductUrls.size === previousSize) {
      logProgress(
        "URL_COLLECTION",
        "Reached page bottom with no new URLs. Stopping."
      );
      break;
    }
  }

  return {
    productUrls: Array.from(allProductUrls),
    totalProducts,
    isIndeterminate,
  };
};

// Scrape product details from individual product page
// Scrape product details from individual product page
const scrapeProductDetails = async (page, url) => {
  try {
    logProgress("DETAIL", `Scraping details from: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    // Optional: Click on the first gallery thumbnail to load full-size images in the modal
    await page.evaluate(() => {
      const firstThumbnail = document.querySelector(
        ".product-slide.thumbnail-feature img"
      );
      if (firstThumbnail) {
        firstThumbnail.click();
      }
    });
    await delay(1000); // Wait for the modal/gallery to load

    const productDetails = await page.evaluate(() => {
      const imageSources = new Set();

      // 1. Main product image (often full-size or close to it)
      const mainImage = document.querySelector(".base-product-image img");
      if (mainImage) {
        let src = mainImage.getAttribute("src");
        // Replace size parameters in URL (e.g., 800x800 to original or larger)
        if (src && src.includes("800x800")) {
          src = src.replace(/(\d+x\d+)/, ""); // Attempt to get original size
        }
        if (src) imageSources.add(src);
      }

      // 2. Gallery modal images (typically full-size)
      const modalImages = document.querySelectorAll(".gallery-modal img");
      modalImages.forEach((img) => {
        let src = img.getAttribute("src");
        if (src && src.includes("thumbnail")) {
          src = src.replace("thumbnail", ""); // Remove thumbnail keyword if present
        }
        if (src) imageSources.add(src);
      });

      // 3. Fallback: Slider images with URL transformation
      const sliderImages = document.querySelectorAll(
        ".product-slide.thumbnail-feature img"
      );
      sliderImages.forEach((img) => {
        let src = img.getAttribute("src");
        if (src) {
          // Trendyol often uses size suffixes like "100x100" or "800x800"
          src = src.replace(/(\d+x\d+)/, ""); // Attempt to request original size
          imageSources.add(src);
        }
      });

      // Convert Set to string with semicolon separator
      const images = Array.from(imageSources).join(";");

      // Rest of the existing evaluation logic...
      const brandElement = document.querySelector(
        "span.product-description-market-place"
      );
      const brand = brandElement ? brandElement.textContent.trim() : null;

      const titleElement = document.querySelector("h3.detail-name");
      const title = titleElement ? titleElement.textContent.trim() : null;

      const priceElement = document.querySelector("span.prc-dsc");
      let price = null;
      let currency = null;
      if (priceElement) {
        const priceText = priceElement.textContent.trim();
        const priceMatch = priceText.match(/([\d.,]+)\s*(\w+)/);
        if (priceMatch) {
          price = parseFloat(priceMatch[1].replace(",", "."));
          currency = priceMatch[2];
        }
      }

      const ratingElement = document.querySelector(
        ".product-rating-score .value"
      );
      const rating = ratingElement
        ? parseFloat(ratingElement.textContent.trim())
        : null;

      const specElements = document.querySelectorAll(
        ".detail-attr-container .detail-attr-item"
      );
      const specifications = Array.from(specElements).map((spec) => {
        const name =
          spec.querySelector(".attr-key-name-w")?.textContent.trim() || "";
        const value =
          spec.querySelector(".attr-value-name-w")?.textContent.trim() || "";
        return { name, value };
      });

      const breadcrumbElements = document.querySelectorAll(
        ".product-detail-breadcrumb-item span"
      );
      const uniqueCategories = new Set(
        Array.from(breadcrumbElements)
          .map((el) => el.textContent.trim())
          .filter((cat) => cat !== "Trendyol" && !cat.includes("Baby Turco"))
      );
      const categories = Array.from(uniqueCategories).join(">");

      const descriptionElement = document.querySelector(".detail-border");
      const descriptionHtml = descriptionElement
        ? descriptionElement.outerHTML
        : null;

      return {
        brand,
        title,
        price,
        currency,
        images,
        rating,
        specifications,
        categories,
        descriptionHtml,
      };
    });

    const productIdMatch = url.match(/p-(\d+)/);
    const productId = productIdMatch ? productIdMatch[1] : null;

    return {
      url,
      productId,
      brand: productDetails.brand,
      title: productDetails.title,
      price: productDetails.price,
      currency: productDetails.currency,
      images: productDetails.images,
      rating: productDetails.rating,
      specifications: productDetails.specifications,
      categories: productDetails.categories,
      description: productDetails.descriptionHtml,
    };
  } catch (error) {
    console.error(`Error scraping ${url}:`, error.message);
    return {
      url,
      productId: null,
      brand: null,
      title: null,
      price: null,
      currency: null,
      images: null,
      rating: null,
      specifications: [],
      categories: "",
      description: null,
    };
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
    const trendyolDir = path.join(outputDir, "trendyol");
    if (!fs.existsSync(trendyolDir))
      fs.mkdirSync(trendyolDir, { recursive: true });

    const browser = await launchBrowser();

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing: ${baseUrl}`);
      let processedUrls = loadExistingProducts(baseUrl, trendyolDir);
      let productsArray = [];

      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];
      const outputFileName = path.join(
        trendyolDir,
        `products_${dateStr}_${urlSlug}_${timestamp}.json`
      );

      const mainPage = await browser.newPage();
      await mainPage.setViewport({ width: 1366, height: 768 });
      await mainPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      const { productUrls, totalProducts, isIndeterminate } =
        await extractProductUrls(mainPage, baseUrl);
      await mainPage.close();

      logProgress(
        "MAIN",
        `Found ${productUrls.length} product URLs out of ${totalProducts}${
          isIndeterminate ? "+" : ""
        }`
      );

      const detailPage = await browser.newPage();
      await detailPage.setViewport({ width: 1366, height: 768 });
      await detailPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      for (let i = 0; i < productUrls.length && !shouldStop; i++) {
        if (processedUrls.has(productUrls[i])) {
          logProgress(
            "MAIN",
            `Skipping already processed URL: ${productUrls[i]}`
          );
          continue;
        }

        const productDetails = await scrapeProductDetails(
          detailPage,
          productUrls[i]
        );
        productsArray.push(productDetails);

        logProgress(
          "MAIN",
          `Processed ${i + 1}/${productUrls.length} products`
        );
        saveProductsToFile(productsArray, outputFileName);
        await delay(1000);
      }

      await detailPage.close();

      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productsArray.length}/${totalProducts}${
          isIndeterminate ? "+" : ""
        } products saved to ${outputFileName}`
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

// Handle graceful shutdown
process.on("SIGINT", async () => {
  shouldStop = true;
  logProgress("SHUTDOWN", "Received SIGINT. Shutting down gracefully...");
  if (browser) await browser.close();
  process.exit(0);
});

scrapeMultipleUrls();
