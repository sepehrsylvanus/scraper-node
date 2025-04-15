const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const username = "brd-customer-hl_39926417-zone-sylvanus";
const password = "ls60pzr5wtn2";
const proxyHost = "brd.superproxy.io";
const proxyPort = 22225;
const session_id = (10000000 * Math.random()) | 0;

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
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:91.0) Gecko/20100101 Firefox/91.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:90.0) Gecko/20100101 Firefox/90.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:88.0) Gecko/20100101 Firefox/88.0",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Launch browser with Bright Data proxy
const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      logProgress("BROWSER", `Launching browser (attempt ${i + 1})...`);

      browser = await puppeteer.launch({
        headless: false, // Set to true for production
        args: ["--no-sandbox", "--start-maximized"],
      });

      const page = await browser.newPage();

      // Set proxy authentication
      await page.authenticate({
        username: `${username}-session-${session_id}`,
        password,
      });

      // Set user agent
      await page.setUserAgent(getRandomUserAgent());

      logProgress("BROWSER", "Browser launched successfully");
      return page;
    } catch (error) {
      logProgress(
        "BROWSER",
        `Browser launch attempt ${i + 1} failed: ${error}`
      );
      if (i === retries - 1) throw error;
      await delay(2000);
    }
  }
};

// Scrape product details
const scrapeProductDetails = async (page, url, retries = 2) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector("#productTitle", { timeout: 20000 });

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
          const fractionPrice = fractionPriceElement.textContent.padStart(
            2,
            "0"
          );
          currency = currencyElement.textContent;
          price = parseFloat(`${wholePriceText}.${fractionPrice}`);
          if (price > 100) price = price / 1000;
        }

        const productIdMatch =
          window.location.href.match(/\/dp\/([A-Z0-9]{10})/);
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

        const title =
          document.querySelector("#productTitle")?.textContent.trim() || "";
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

        const specifications = Array.from(
          document.querySelectorAll("#productDetails_techSpec_section_1 tr")
        )
          .map((row) => ({
            name: row.querySelector("th")?.textContent.trim() || "",
            value:
              row.querySelector("td")?.textContent.trim().replace("‎", "") ||
              "",
          }))
          .filter((spec) => spec.name && spec.value);

        const categories = Array.from(
          document.querySelectorAll(
            "ul.a-unordered-list.a-horizontal .a-list-item a.a-link-normal"
          )
        )
          .map((el) => el.textContent.trim())
          .join(">");

        const description = Array.from(
          document.querySelectorAll(
            "#feature-bullets ul.a-unordered-list.a-vertical.a-spacing-mini li span.a-list-item"
          )
        )
          .map((item) => item.textContent.trim())
          .join("\n");

        return {
          price,
          currency,
          productId,
          brand,
          title,
          images,
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
        title: productData.title,
        price:
          productData.price !== null
            ? parseFloat(productData.price.toFixed(3))
            : null,
        currency: productData.currency,
        images: productData.images,
        rating: productData.rating,
        specifications: productData.specifications,
        categories: productData.categories,
        description: productData.description,
      };
    } catch (error) {
      logProgress(
        "PRODUCT_SCRAPING",
        `Attempt ${attempt + 1} failed: ${error.message}`
      );
      if (attempt === retries - 1) {
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
      await delay(2000);
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
  retries = 2
) => {
  let currentPage = 1;
  const maxPages = 10;
  let currentUrl = baseUrl;

  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  });

  while (currentPage <= maxPages && currentUrl) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        logProgress(
          "PAGE_SCRAPING",
          `Navigating to page ${currentPage}: ${currentUrl}`
        );
        await page.goto(currentUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        await page.waitForSelector(".puis-card-container", { timeout: 20000 });

        const { productUrls, nextPageUrl } = await page.evaluate(() => {
          const productUrls = Array.from(
            document.querySelectorAll(
              ".puis-card-container a.a-link-normal.s-no-outline"
            )
          )
            .map((link) => link.getAttribute("href"))
            .filter((url) => url && url.includes("/dp/"))
            .map((url) =>
              url.startsWith("http") ? url : `https://www.amazon.com.tr${url}`
            );

          const nextButton = document.querySelector(
            'a.s-pagination-item.s-pagination-next[aria-label^="Sonraki sayfaya git"]'
          );
          const nextPageUrl = nextButton
            ? `https://www.amazon.com.tr${nextButton.getAttribute("href")}`
            : null;

          return { productUrls, nextPageUrl };
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

          const productData = await scrapeProductDetails(page, url);
          productDataArray.push(productData);
          processedUrls.add(url);
          logProgress("PAGE_SCRAPING", `Scraped ${url} successfully`);
          saveUrlsToFile(productDataArray, outputFileName);
          await delay(Math.random() * 1000 + 500);
        }

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
        await delay(2000);
      }
    }
    if (currentUrl) await delay(Math.random() * 2000 + 1000);
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
    const amazonDir = path.join(outputDir, "amazon");
    if (!fs.existsSync(amazonDir)) fs.mkdirSync(amazonDir, { recursive: true });

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

      const page = await launchBrowser();
      await scrapePageByPage(
        page,
        baseUrl,
        processedUrls,
        productDataArray,
        outputFileName
      );
      await page.close();

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
