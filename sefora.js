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
        headless: false,
        protocolTimeout: 86400000,
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

// Extract product URLs with improved loop handling
const extractProductUrls = async (page, baseUrl) => {
  logProgress("URL_COLLECTION", `Starting with base URL: ${baseUrl}`);
  let allProductUrls = new Set();
  let retryCount = 0;
  const maxRetries = 3; // Maximum number of scroll reset attempts

  await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 60000 });

  // Get total products count
  const totalProducts = await page.evaluate(() => {
    const resultsElement = document.querySelector(".results-hits span");
    return resultsElement
      ? parseInt(resultsElement.textContent.replace(/[^0-9]/g, ""))
      : 0;
  });
  logProgress("URL_COLLECTION", `Total products expected: ${totalProducts}`);

  // Initial scroll and button handling
  try {
    await page.evaluate(async () => {
      const seeMoreButton = document.querySelector(
        "button.see-more-button[data-js-infinitescroll-see-more]"
      );
      if (seeMoreButton) {
        seeMoreButton.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        seeMoreButton.focus();
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
  const maxNoNewProductsTime = 5000; // 5 seconds
  const scrollStep = 500;
  const minProductsToCollect = totalProducts - 1;

  while (!shouldStop && retryCount < maxRetries) {
    // Check if we've reached our target
    if (allProductUrls.size >= minProductsToCollect) {
      logProgress(
        "URL_COLLECTION",
        `Reached target of ${minProductsToCollect} products. Stopping scroll.`
      );
      break;
    }

    // Check if footer is visible
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

    if (footerVisible) {
      logProgress("URL_COLLECTION", "Footer reached.");
      if (allProductUrls.size < minProductsToCollect) {
        retryCount++;
        logProgress(
          "URL_COLLECTION",
          `Retry ${retryCount}/${maxRetries}: Only ${allProductUrls.size} products found out of ${totalProducts} expected.`
        );

        if (retryCount >= maxRetries) {
          logProgress(
            "URL_COLLECTION",
            `Max retries reached. Proceeding with ${allProductUrls.size} products.`
          );
          break;
        }

        // Improved scroll reset with slower scrolling
        await page.evaluate(async (step) => {
          // Scroll to top
          window.scrollTo({ top: 0, behavior: "smooth" });
          await new Promise((resolve) => setTimeout(resolve, 2000));

          // Slower scroll down to ensure loading
          let currentPosition = 0;
          const maxHeight = document.body.scrollHeight;
          while (currentPosition < maxHeight) {
            window.scrollBy(0, step);
            currentPosition += step;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }, scrollStep);

        logProgress("URL_COLLECTION", "Completed enhanced scroll reset");
        continue;
      } else {
        break;
      }
    }

    // Get current product URLs
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

    // Check if new products were loaded
    if (allProductUrls.size === previousProductCount) {
      noNewProductsTime += 1000;
      if (noNewProductsTime >= maxNoNewProductsTime) {
        logProgress(
          "URL_COLLECTION",
          `No new products for 5 seconds. Current count: ${allProductUrls.size}/${totalProducts}`
        );
        if (
          allProductUrls.size < minProductsToCollect &&
          retryCount < maxRetries
        ) {
          retryCount++;
          logProgress(
            "URL_COLLECTION",
            `Retry ${retryCount}/${maxRetries}: Initiating scroll reset`
          );
          await page.evaluate(() =>
            window.scrollTo({ top: 0, behavior: "smooth" })
          );
          noNewProductsTime = 0;
        } else {
          break;
        }
      }
    } else {
      noNewProductsTime = 0;
      previousProductCount = allProductUrls.size;
    }

    // Scroll down
    await page.evaluate((step) => {
      window.scrollBy(0, step);
    }, scrollStep);
    await delay(1000);
  }

  if (allProductUrls.size < minProductsToCollect) {
    logProgress(
      "URL_COLLECTION",
      `Warning: Only collected ${allProductUrls.size} out of ${totalProducts} expected products`
    );
  }

  return Array.from(allProductUrls);
};

// Scrape product details from individual product page
const scrapeProductDetails = async (page, url) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

  const productData = await page.evaluate(() => {
    const productTile = document.querySelector(".product-tile.clickable");
    const data = productTile
      ? JSON.parse(productTile.getAttribute("data-tcproduct"))
      : {};

    const priceElement = document.querySelector(".price-sales-standard");
    const priceText = priceElement ? priceElement.textContent.trim() : "";
    const priceMatch = priceText.match(/([\d.,]+)\s*TL/);
    const price = priceMatch
      ? parseFloat(priceMatch[1].replace(".", "").replace(",", "."))
      : null;

    const brandElement = document.querySelector(".product-brand");
    const titleElement = document.querySelector(".product-title");
    const ratingIcons = document.querySelectorAll(".product-rating-icon");
    const reviewCountElement = document.querySelector(".amount-of-reviews");
    const images = document.querySelectorAll(".product-imgs img");
    const variationElement = document.querySelector(".product-variation-name");

    let rating = 0;
    ratingIcons.forEach((icon) => {
      if (icon.src.includes("rating-star-full-icon")) rating += 1;
      else if (icon.tagName === "svg") rating += 0.5;
    });

    return {
      productId: data.product_pid || "",
      brand: brandElement
        ? brandElement.textContent.trim()
        : data.product_brand || "",
      title: titleElement
        ? titleElement.textContent.trim()
        : data.product_pid_name || "",
      price: price,
      currency: "TRY",
      images: Array.from(images)
        .map((img) => img.src)
        .join(";"),
      rating: rating || null,
      specifications: [
        {
          name: "Variation",
          value: variationElement ? variationElement.textContent.trim() : "",
        },
      ],
      categories: data.product_breadcrumb_label || "",
      description: "",
    };
  });

  return {
    url,
    productId: productData.productId,
    brand: productData.brand,
    title: productData.title,
    price: productData.price,
    currency: productData.currency,
    images: productData.images,
    rating: productData.rating,
    specifications: productData.specifications.filter((spec) => spec.value),
    categories: productData.categories,
    description: productData.description,
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
const scrapeSephoraUrls = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node script.js <url1> <url2> ...");
    process.exit(1);
  }

  try {
    const sephoraDir = path.join(outputDir, "sephora");
    if (!fs.existsSync(sephoraDir))
      fs.mkdirSync(sephoraDir, { recursive: true });

    const browser = await launchBrowser();

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

      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      const productUrls = await extractProductUrls(page, baseUrl);
      await page.close();

      logProgress("MAIN", `Found ${productUrls.length} product URLs`);

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
            `Scraped details for ${url}: Price=${productData.price}, Rating=${productData.rating}`
          );
          saveUrlsToFile(productDataArray, outputFileName);
        } catch (error) {
          console.error(`Failed to scrape ${url}:`, error);
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
          });
          saveUrlsToFile(productDataArray, outputFileName);
        }
        await delay(1000);
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

scrapeSephoraUrls();
