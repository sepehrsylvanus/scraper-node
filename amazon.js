const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const https = require("https");

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

// Fetch proxies from ProxyScrape API
const fetchProxies = () => {
  return new Promise((resolve, reject) => {
    const url =
      "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all";
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          const proxies = data
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((proxy) => `http://${proxy.trim()}`);
          resolve(proxies.slice(0, 5)); // Limit to 5 proxies
        });
      })
      .on("error", (err) => reject(err));
  });
};

// Launch browser with proxy or direct connection
const launchBrowser = async (proxies, retries = 3) => {
  let proxy = proxies.length
    ? proxies[Math.floor(Math.random() * proxies.length)]
    : null;
  for (let i = 0; i < retries; i++) {
    try {
      const args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--start-maximized",
      ];
      if (proxy) {
        logProgress(
          "BROWSER",
          `Launching browser with proxy ${proxy} (attempt ${i + 1})...`
        );
        args.push(`--proxy-server=${proxy}`);
      } else {
        logProgress(
          "BROWSER",
          `Launching browser without proxy (attempt ${i + 1})...`
        );
      }

      browser = await puppeteer.launch({
        headless: false, // Set to true for production
        protocolTimeout: 180000,
        args,
        defaultViewport: null,
      });

      const tempPage = await browser.newPage();
      await tempPage.setUserAgent(getRandomUserAgent());
      await tempPage.close();

      logProgress("BROWSER", "Browser launched successfully");
      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${i + 1} failed:`, error);
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
          if (price > 100) price = price / 1000; // Adjust for possible formatting issues
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

  await page.setUserAgent(getRandomUserAgent());
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
        break; // Move to next page
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

  let proxies = [];
  try {
    proxies = await fetchProxies();
    logProgress("PROXY", `Fetched ${proxies.length} proxies`);
  } catch (error) {
    logProgress("PROXY", `Failed to fetch proxies: ${error.message}`);
    proxies = []; // Fallback to direct connection
  }

  try {
    const amazonDir = path.join(outputDir, "amazon");
    if (!fs.existsSync(amazonDir)) fs.mkdirSync(amazonDir, { recursive: true });

    browser = await launchBrowser(proxies);

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

      const page = await browser.newPage();
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
