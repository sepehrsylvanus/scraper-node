const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");

puppeteer.use(StealthPlugin());

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

// Enhanced pool of user agents
const getRandomUserAgent = () => {
  const userAgents = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Launch browser with enhanced stealth features
const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      logProgress("BROWSER", `Launching browser (attempt ${i + 1})...`);
      browser = await puppeteer.launch({
        headless: "new", // Use new headless mode
        protocolTimeout: 180000,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--no-first-run",
          "--disable-gpu",
          "--disable-blink-features=AutomationControlled",
          "--disable-web-security",
          "--disable-xss-auditor",
          "--disable-notifications",
          "--disable-infobars",
          "--window-size=1280,800",
          // Uncomment and configure proxy if available
          // "--proxy-server=http://your-proxy:port",
        ],
        defaultViewport: { width: 1280, height: 800 },
      });

      // Spoof additional browser features
      const page = await browser.newPage();
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => false });
        Object.defineProperty(navigator, "languages", {
          get: () => ["en-US", "en"],
        });
        Object.defineProperty(navigator, "plugins", {
          get: () => [1, 2, 3, 4, 5],
        });
      });
      await page.close();

      logProgress("BROWSER", "Browser launched successfully");
      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await delay(5000);
    }
  }
};

// Enhanced human-like behavior simulation
const simulateHumanBehavior = async (page) => {
  try {
    await page.evaluate(() => {
      const scrollHeight = document.body.scrollHeight;
      const randomScroll = Math.floor(Math.random() * (scrollHeight - 800));
      window.scrollTo({
        top: randomScroll,
        behavior: "smooth",
      });
    });

    // Random mouse movements
    await page.mouse.move(
      Math.random() * 800 + 200,
      Math.random() * 600 + 100,
      { steps: 10 }
    );

    // Random typing simulation
    await page.keyboard.press("ArrowDown");
    await delay(Math.random() * 2000 + 1000);
  } catch (error) {
    logProgress("SIMULATION", `Failed to simulate behavior: ${error.message}`);
  }
};

// Check for "Üzgünüz" page
const checkForSorryPage = async (page) => {
  const content = await page.content();
  return content.includes("Üzgünüz") || content.includes("Sorry");
};

// Get total products count
const getTotalProducts = async (page) => {
  try {
    const resultText = await page.evaluate(() => {
      const element = document.querySelector(
        ".s-breadcrumb .a-size-base.a-spacing-small.a-spacing-top-small.a-text-normal span"
      );
      return element ? element.textContent.trim() : "";
    });

    if (!resultText) return 48;

    const match = resultText.match(
      /(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?) \/ (\d+(?:\.\d+)?(?:\.\d+)?) üzeri sonuç/
    );
    if (match) {
      return parseInt(match[3].replace(/\./g, ""));
    }

    const simpleMatch = resultText.match(/(\d+(?:\.\d+)?) sonuç/);
    if (simpleMatch) {
      return parseInt(simpleMatch[1].replace(/\./g, ""));
    }

    return 48;
  } catch (error) {
    logProgress("TOTAL", `Error getting total products: ${error.message}`);
    return 48;
  }
};

// Scrape product details
const scrapeProductDetails = async (page, url, retries = 3) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await page.setUserAgent(getRandomUserAgent());
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9,tr-TR;q=0.8",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        Referer: "https://www.amazon.com.tr/",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Connection: "keep-alive",
      });

      await page.goto(url, { waitUntil: "networkidle0", timeout: 90000 });

      if (await checkForSorryPage(page)) {
        throw new Error("Detected Üzgünüz page");
      }

      await page.waitForSelector("#productTitle", { timeout: 30000 });
      await simulateHumanBehavior(page);

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
      await delay(10000); // Increased delay on retry
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
  retries = 3
) => {
  let currentPage = 1;
  const productsPerPage = 48;
  const totalProducts = await getTotalProducts(page);
  const maxPages = Math.ceil(totalProducts / productsPerPage);

  logProgress(
    "PAGE_SCRAPING",
    `Total products: ${totalProducts}, Max pages: ${maxPages}`
  );

  await page.setUserAgent(getRandomUserAgent());
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9,tr-TR;q=0.8",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    Referer: "https://www.amazon.com.tr/",
    "Upgrade-Insecure-Requests": "1",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Connection: "keep-alive",
  });

  let currentUrl = baseUrl;
  while (currentPage <= maxPages && currentUrl) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        logProgress(
          "PAGE_SCRAPING",
          `Navigating to page ${currentPage}: ${currentUrl}`
        );
        await page.goto(currentUrl, {
          waitUntil: "networkidle0",
          timeout: 90000,
        });

        if (await checkForSorryPage(page)) {
          logProgress(
            "PAGE_SCRAPING",
            "Detected Üzgünüz page, retrying with new page..."
          );
          await page.close();
          page = await browser.newPage();
          await page.setUserAgent(getRandomUserAgent());
          await page.setExtraHTTPHeaders({
            "Accept-Language": "en-US,en;q=0.9,tr-TR;q=0.8",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            Referer: "https://www.amazon.com.tr/",
            "Upgrade-Insecure-Requests": "1",
          });
          throw new Error("Üzgünüz page detected");
        }

        await page.waitForSelector(".puis-card-container", { timeout: 30000 });
        await simulateHumanBehavior(page);

        const { productUrls, nextPageUrl } = await page.evaluate(() => {
          const productCards = document.querySelectorAll(
            ".puis-card-container"
          );
          const productUrls = Array.from(productCards)
            .map((card) => {
              const link = card.querySelector("a.a-link-normal.s-no-outline");
              return link ? link.getAttribute("href") : null;
            })
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

        const productPage = await browser.newPage();
        await productPage.setUserAgent(getRandomUserAgent());
        await productPage.setExtraHTTPHeaders({
          "Accept-Language": "en-US,en;q=0.9,tr-TR;q=0.8",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          Referer: currentUrl,
          "Upgrade-Insecure-Requests": "1",
        });

        for (const url of productUrls) {
          if (processedUrls.has(url)) {
            logProgress(
              "PAGE_SCRAPING",
              `Skipping already processed URL: ${url}`
            );
            continue;
          }

          try {
            const productData = await scrapeProductDetails(productPage, url);
            productDataArray.push(productData);
            processedUrls.add(url);
            logProgress("PAGE_SCRAPING", `Scraped ${url} successfully`);
            saveUrlsToFile(productDataArray, outputFileName);
          } catch (error) {
            logProgress(
              "PAGE_SCRAPING",
              `Failed to scrape ${url}: ${error.message}`
            );
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
          await delay(Math.random() * 5000 + 5000); // Increased delay between products
        }

        await productPage.close();
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
        await delay(15000); // Increased delay between retries
      }
    }

    if (currentUrl) {
      await delay(Math.random() * 15000 + 10000); // Increased page transition delay
    }
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
    browser = await launchBrowser();

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

      let page = await browser.newPage();
      try {
        await scrapePageByPage(
          page,
          baseUrl,
          processedUrls,
          productDataArray,
          outputFileName
        );
      } finally {
        await page.close();
      }

      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productDataArray.length} entries saved to ${outputFileName}`
      );
    }
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
  } finally {
    if (browser) await browser.close();
    logProgress("MAIN", "Browser closed");
    process.exit(0);
  }
};

scrapeAmazonProducts();
