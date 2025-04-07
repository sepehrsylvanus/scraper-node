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
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Launch browser without proxy for simplicity
const launchBrowser = async () => {
  try {
    logProgress("BROWSER", "Launching browser without proxy...");
    browser = await puppeteer.launch({
      headless: false, // Keep false for debugging
      protocolTimeout: 180000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--start-maximized",
      ],
      defaultViewport: null,
    });

    const page = await browser.newPage();
    await page.setUserAgent(getRandomUserAgent());
    await page.goto("https://www.google.com", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    logProgress("BROWSER", "Successfully connected to Google");
    await page.close();

    logProgress("BROWSER", "Browser launched successfully");
    return browser;
  } catch (error) {
    throw new Error(`Browser launch failed: ${error.message}`);
  }
};

// Scrape product details
const scrapeProductDetails = async (page, url) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to: ${url}`);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("#productTitle", { timeout: 20000 });

    const productData = await page.evaluate(() => {
      const title =
        document.querySelector("#productTitle")?.textContent.trim() || "";
      const priceWhole =
        document
          .querySelector("span.a-price-whole")
          ?.textContent.replace(/[^0-9]/g, "") || "";
      const priceFraction =
        document
          .querySelector("span.a-price-fraction")
          ?.textContent.padStart(2, "0") || "";
      const currency =
        document.querySelector("span.a-price-symbol")?.textContent || "";
      const price =
        priceWhole && priceFraction
          ? parseFloat(`${priceWhole}.${priceFraction}`)
          : null;
      const productId =
        window.location.href.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || "";
      const brand =
        Array.from(
          document.querySelectorAll("#productDetails_techSpec_section_1 tr")
        )
          .find(
            (row) => row.querySelector("th")?.textContent.trim() === "Marka Adı"
          )
          ?.querySelector("td")
          ?.textContent.trim()
          .replace("‎", "") || "";
      const images = Array.from(
        document.querySelectorAll(
          "#altImages .imageThumbnail img, #altImages .videoThumbnail img"
        )
      )
        .map((img) => img.getAttribute("src"))
        .filter((src, i, arr) => src && arr.indexOf(src) === i)
        .join(";");
      const rating =
        parseFloat(
          document
            .querySelector("#acrPopover .a-size-base.a-color-base")
            ?.textContent.trim()
            .replace(",", ".")
        ) || null;

      return { title, price, currency, productId, brand, images, rating };
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
    };
  } catch (error) {
    logProgress("PRODUCT_SCRAPING", `Failed: ${error.message}`);
    return {
      url,
      productId: "",
      brand: "",
      title: "",
      price: null,
      currency: "",
      images: "",
      rating: null,
    };
  }
};

// Save data to file
const saveUrlsToFile = (data, filePath) => {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  logProgress("FILE", `Saved ${data.length} entries to ${filePath}`);
};

// Main scraping function
const scrapeAmazonProducts = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node scraper.js <url>");
    process.exit(1);
  }

  try {
    const amazonDir = path.join(outputDir, "amazon");
    if (!fs.existsSync(amazonDir)) fs.mkdirSync(amazonDir, { recursive: true });

    browser = await launchBrowser();

    const page = await browser.newPage();
    await page.setUserAgent(getRandomUserAgent());
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    });

    for (const baseUrl of urls) {
      logProgress("MAIN", `Processing URL: ${baseUrl}`);
      const productDataArray = [];
      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const outputFileName = path.join(
        amazonDir,
        `products_${dateStr}_${urlSlug}.json`
      );

      logProgress("MAIN", `Navigating to ${baseUrl}`);
      await page.goto(baseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      // Scrape product URLs with updated selector
      const productUrls = await page.evaluate(() => {
        const links = Array.from(
          document.querySelectorAll(
            ".s-result-item a.s-no-outline[href*='/dp/']"
          )
        );
        return links.map((link) => {
          const href = link.getAttribute("href");
          return href.startsWith("http")
            ? href
            : `https://www.amazon.com.tr${href}`;
        });
      });

      logProgress("MAIN", `Found ${productUrls.length} product URLs`);
      if (productUrls.length === 0) {
        const htmlSnippet = await page.content();
        logProgress(
          "DEBUG",
          `No products found. Page snippet: ${htmlSnippet.substring(0, 500)}...`
        );
      }

      for (const url of productUrls) {
        const productData = await scrapeProductDetails(page, url);
        productDataArray.push(productData);
        saveUrlsToFile(productDataArray, outputFileName);
        await delay(1000); // Avoid rate limiting
      }

      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productDataArray.length} entries saved`
      );
    }

    await browser.close();
    logProgress("MAIN", "Browser closed");
    process.exit(0);
  } catch (error) {
    console.error("[FATAL] Fatal error:", error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
};

scrapeAmazonProducts();
