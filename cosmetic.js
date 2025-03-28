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

    const nextButton = await page.$("button.next-page:not(.disabled)");
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
    await delay(2000);
  }

  return Array.from(allProductUrls);
};

// Scrape product details from individual product page
const scrapeProductDetails = async (page, url) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

  const productData = await page.evaluate(() => {
    const imageElements = document.querySelectorAll("img");
    const images = Array.from(imageElements)
      .map((img) => img.getAttribute("src"))
      .filter((src) => src && src.startsWith("http"));

    const brandElement = document.querySelector(
      "a.-mb-px.text-sm.font-bold.text-button-01\\/70"
    );
    const titleElement = document.querySelector("h1.mb-2.text-left.text-lg");

    const priceElement = document.querySelector(
      "div.text-base.font-semibold.\\!leading-none.text-button-01.md\\:text-lg"
    );
    const priceText = priceElement ? priceElement.textContent.trim() : null;
    const price = priceText ? priceText.replace("₺", "").trim() : null;

    const starElements = document.querySelectorAll("svg.size-\\15px\\]");
    const rating = Array.from(starElements).filter((star) =>
      star.classList.contains("text-amber-500")
    ).length;

    const descriptionElement = document.querySelector(
      "div.prose.prose-sm.mt-6.max-w-none > div"
    );
    const description = descriptionElement
      ? descriptionElement.textContent.trim()
      : null;

    // Extract categories from breadcrumb (excluding last item) and join with ">"
    const breadcrumbItems = document.querySelectorAll(
      "nav[aria-label='breadcrumb'] ul li"
    );
    const categoriesArray = Array.from(breadcrumbItems)
      .slice(0, -1) // Exclude the last item (product name)
      .map((item) => {
        const link = item.querySelector("a");
        return link ? link.textContent.trim() : null;
      })
      .filter(Boolean);
    const categories =
      categoriesArray.length > 0 ? categoriesArray.join(">") : null;

    // Extract product ID from URL (second part after domain)
    const productId = window.location.href.replace(
      "https://www.cosmetica.com.tr/",
      ""
    );

    return {
      url: window.location.href,
      productId: productId,
      brand: brandElement ? brandElement.textContent.trim() : null,
      title: titleElement ? titleElement.textContent.trim() : null,
      price: price,
      currency: priceText && priceText.includes("₺") ? "TRY" : null,
      rating: rating,
      images: images.length > 0 ? images : null,
      description: description,
      categories: categories,
    };
  });

  if (!productData) {
    return {
      url,
      productId: url.replace("https://www.cosmetica.com.tr/", ""),
      brand: null,
      title: null,
      price: null,
      currency: null,
      rating: null,
      images: null,
      description: null,
      categories: null,
    };
  }

  return productData;
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
          logProgress("MAIN", `Scraped details for ${url}`);
          saveUrlsToFile(productDataArray, outputFileName);
        } catch (error) {
          console.error(`Failed to scrape ${url}:`, error);
          productDataArray.push({
            url,
            productId: url.replace("https://www.cosmetica.com.tr/", ""),
            brand: null,
            title: null,
            price: null,
            currency: null,
            rating: null,
            images: null,
            description: null,
            categories: null,
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

scrapeCosmeticUrls();
