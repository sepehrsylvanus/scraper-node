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
          resolve(proxies.slice(0, 5));
        });
      })
      .on("error", (err) => {
        logProgress("PROXY", `Proxy fetch failed: ${err.message}`);
        resolve([]); // Return empty array on failure
      });
  });
};

// Launch browser with optional proxy
const launchBrowser = async (proxies, retries = 3) => {
  let useProxy = proxies.length > 0;
  for (let i = 0; i < retries; i++) {
    try {
      const args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--start-maximized",
      ];
      let proxy;
      if (useProxy) {
        proxy = proxies[Math.floor(Math.random() * proxies.length)];
        logProgress(
          "BROWSER",
          `Launching with proxy ${proxy} (attempt ${i + 1})...`
        );
        args.push(`--proxy-server=${proxy}`);
      } else {
        logProgress("BROWSER", `Launching without proxy (attempt ${i + 1})...`);
      }

      browser = await puppeteer.launch({
        headless: false, // Keep false for debugging
        protocolTimeout: 180000,
        args,
        defaultViewport: null,
      });

      const page = await browser.newPage();
      await page.setUserAgent(getRandomUserAgent());
      // Test connectivity with a simple page
      await page.goto("https://www.google.com", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      logProgress("BROWSER", "Successfully connected to Google");
      await page.close();

      logProgress("BROWSER", "Browser launched successfully");
      return browser;
    } catch (error) {
      console.error(`Launch attempt ${i + 1} failed:`, error.message);
      if (i === retries - 1) {
        if (useProxy) {
          logProgress("BROWSER", "Proxy failed, retrying without proxy...");
          useProxy = false; // Switch to no proxy for next retry
          i = -1; // Reset retry count
          continue;
        }
        throw error;
      }
      await delay(2000);
    }
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

  let proxies = [];
  try {
    proxies = await fetchProxies();
    logProgress("PROXY", `Fetched ${proxies.length} proxies`);
  } catch (error) {
    logProgress("PROXY", "Proceeding without proxies");
  }

  try {
    const amazonDir = path.join(outputDir, "amazon");
    if (!fs.existsSync(amazonDir)) fs.mkdirSync(amazonDir, { recursive: true });

    browser = await launchBrowser(proxies);

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

      // Test base URL connectivity
      logProgress("MAIN", `Testing connectivity to ${baseUrl}`);
      try {
        await page.goto(baseUrl, {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });
        logProgress("MAIN", `Successfully reached ${baseUrl}`);
      } catch (error) {
        logProgress("MAIN", `Failed to reach ${baseUrl}: ${error.message}`);
        continue; // Skip to next URL if base fails
      }

      // Scrape product URLs from the page
      const productUrls = await page.evaluate(() => {
        return Array.from(
          document.querySelectorAll(
            ".puis-card-container a.a-link-normal.s-no-outline"
          )
        )
          .map((link) => link.getAttribute("href"))
          .filter((url) => url && url.includes("/dp/"))
          .map((url) =>
            url.startsWith("http") ? url : `https://www.amazon.com.tr${url}`
          );
      });

      logProgress("MAIN", `Found ${productUrls.length} product URLs`);

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
