const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

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

// Randomize user-agent
const getRandomUserAgent = () => {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.212 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/88.0.4324.96 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Launch browser with retry logic and cleanup
const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      logProgress("BROWSER", `Launching browser (attempt ${i + 1})...`);
      browser = await puppeteer.launch({
        headless: false,
        protocolTimeout: 120000, // Increased timeout to 120s
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-accelerated-2d-canvas",
          "--no-first-run",
          "--disable-gpu",
          "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows",
          "--disable-renderer-backgrounding",
        ],
        defaultViewport: { width: 1280, height: 800 },
        // Handle SIGTERM to gracefully close browser
        handleSIGTERM: true,
        handleSIGHUP: true,
      });

      // Ensure browser cleanup on process exit
      process.on("SIGINT", async () => {
        await browser.close();
        process.exit(0);
      });

      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await delay(2000);
    }
  }
};

// Scrape product details from individual product page
const scrapeProductDetails = async (page, url) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  try {
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector("#productTitle", { timeout: 15000 });

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
    return {
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
    };
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

// Scrape products from a single page
const scrapeSinglePage = async (page, url, processedUrls, productDataArray) => {
  try {
    await page.goto(url, { waitUntil: "networkidle0", timeout: 60000 });
    await page.waitForSelector(".puis-card-container", { timeout: 15000 });
    logProgress("PAGE_SCRAPING", `Loaded page: ${url}`);

    const productUrls = await page.evaluate(() => {
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
      `Found ${productUrls.length} product URLs on ${url}`
    );

    for (const productUrl of productUrls) {
      if (processedUrls.has(productUrl)) {
        logProgress(
          "PAGE_SCRAPING",
          `Skipping already processed URL: ${productUrl}`
        );
        continue;
      }
      const productPage = await browser.newPage();
      try {
        await productPage.setUserAgent(getRandomUserAgent());
        const productData = await scrapeProductDetails(productPage, productUrl);
        productDataArray.push(productData);
        processedUrls.add(productUrl);
      } catch (error) {
        logProgress(
          "PAGE_SCRAPING",
          `Failed to scrape product ${productUrl}: ${error.message}`
        );
      } finally {
        await productPage.close(); // Ensure page is closed even on error
      }
      await delay(Math.random() * 1000 + 500); // Random delay between 0.5-1.5s
    }

    const nextPageUrl = await page.evaluate(() => {
      const nextButton = document.querySelector(
        'a.s-pagination-item.s-pagination-next[aria-label^="Sonraki sayfaya git"]'
      );
      return nextButton
        ? `https://www.amazon.com.tr${nextButton.getAttribute("href")}`
        : null;
    });

    return nextPageUrl;
  } catch (error) {
    logProgress(
      "PAGE_SCRAPING",
      `Error scraping page ${url}: ${error.message}`
    );
    return null;
  }
};

// Main scraping function with better resource management
const scrapeAmazonProducts = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node script.js <url>");
    process.exit(1);
  }

  try {
    const amazonDir = path.join(outputDir, "amazon");
    if (!fs.existsSync(amazonDir)) fs.mkdirSync(amazonDir, { recursive: true });

    browser = await launchBrowser();

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

      let currentUrl = baseUrl;
      const maxPages = 1000; // Adjust based on your needs
      let pageCount = 1;

      while (currentUrl && pageCount <= maxPages) {
        const page = await browser.newPage();
        try {
          await page.setUserAgent(getRandomUserAgent());
          await page.setExtraHTTPHeaders({
            "Accept-Language": "en-US,en;q=0.9",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          });

          logProgress("MAIN", `Scraping page ${pageCount} of ${maxPages}`);
          currentUrl = await scrapeSinglePage(
            page,
            currentUrl,
            processedUrls,
            productDataArray
          );
          saveUrlsToFile(productDataArray, outputFileName);
        } catch (error) {
          logProgress("MAIN", `Error on page ${pageCount}: ${error.message}`);
        } finally {
          await page.close(); // Ensure page is closed even on error
        }

        pageCount++;

        if (productDataArray.length >= 40000) {
          logProgress("MAIN", "Reached target of 40,000 products. Stopping.");
          break;
        }

        await delay(Math.random() * 2000 + 1000); // Random delay between 1-3s

        // Periodically restart browser to prevent memory leaks
        if (pageCount % 50 === 0) {
          logProgress("MAIN", "Restarting browser to free resources...");
          await browser.close();
          browser = await launchBrowser();
        }
      }

      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productDataArray.length} entries saved to ${outputFileName}`
      );
    }

    if (browser) await browser.close();
    logProgress("MAIN", "Browser closed");
    process.exit(0);
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
    if (browser) await browser.close();
    process.exit(1);
  }
};

scrapeAmazonProducts();
