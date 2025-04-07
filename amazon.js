const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

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
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.86 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.129 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.61",
    "Mozilla/5.0 (iPad; CPU OS 16_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.7 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Windows NT 10.0; rv:122.0) Gecko/20100101 Firefox/122.0",
  ];

  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Launch browser with headless: false
const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      logProgress("BROWSER", `Launching browser (attempt ${i + 1})...`);
      browser = await puppeteer.launch({
        headless: false,
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
          // "--proxy-server=http://your-proxy:port", // Uncomment if using proxy
        ],
        defaultViewport: { width: 1280, height: 800 },
      });

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
      window.scrollTo({ top: randomScroll, behavior: "smooth" });
    });
    await page.mouse.move(
      Math.random() * 800 + 200,
      Math.random() * 600 + 100,
      { steps: 10 }
    );
    await page.keyboard.press("ArrowDown");
    await delay(Math.random() * 2000 + 1000);
  } catch (error) {
    logProgress("SIMULATION", `Failed to simulate behavior: ${error.message}`);
  }
};

// Check for "Üzgünüz" or CAPTCHA page
const checkForBlockingPage = async (page) => {
  const content = await page.content();
  const isSorryPage = content.includes("Üzgünüz") || content.includes("Sorry");
  const isCaptchaPage =
    content.includes("robot") || content.includes("CAPTCHA");
  return { isSorryPage, isCaptchaPage };
};

// Prompt user for manual intervention
const promptUser = async (message) => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === "y");
    });
  });
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
    if (match) return parseInt(match[3].replace(/\./g, ""));
    const simpleMatch = resultText.match(/(\d+(?:\.\d+)?) sonuç/);
    if (simpleMatch) return parseInt(simpleMatch[1].replace(/\./g, ""));
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
      const { isSorryPage, isCaptchaPage } = await НапримерcheckForBlockingPage(
        page
      );

      if (isSorryPage) throw new Error("Detected Üzgünüz page");
      if (isCaptchaPage) {
        logProgress(
          "PRODUCT_SCRAPING",
          "CAPTCHA detected. Please solve it manually."
        );
        const proceed = await promptUser(
          "Have you solved the CAPTCHA? (y/n): "
        );
        if (!proceed) throw new Error("User aborted after CAPTCHA");
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
          "ul.a-unordered-list.a-horizontal .a-list-item.a-breadcrumb-item a.a-link-normal"
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
      await delay(10000);
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

// Scrape products page by page with improved logic
const scrapePageByPage = async (
  baseUrl,
  processedUrls,
  productDataArray,
  outputFileName,
  browserRetries = 2
) => {
  let currentPage = 1;
  let page;
  let browserAttempt = 0;

  while (browserAttempt < browserRetries) {
    try {
      if (!browser || !browser.isConnected()) {
        if (browser) await browser.close();
        browser = await launchBrowser();
      }

      page = await browser.newPage();
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

      const productsPerPage = 48;
      const totalProducts = await getTotalProducts(page);
      const maxPages = Math.ceil(totalProducts / productsPerPage);
      logProgress(
        "PAGE_SCRAPING",
        `Total products: ${totalProducts}, Max pages: ${maxPages}`
      );

      let currentUrl = baseUrl;

      while (currentPage <= maxPages && currentUrl) {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            logProgress(
              "PAGE_SCRAPING",
              `Navigating to page ${currentPage}: ${currentUrl}`
            );
            await page.goto(currentUrl, {
              waitUntil: "networkidle0",
              timeout: 90000,
            });

            const { isSorryPage, isCaptchaPage } = await checkForBlockingPage(
              page
            );
            if (isSorryPage) {
              logProgress("PAGE_SCRAPING", "Detected Üzgünüz page");
              throw new Error("Üzgünüz page detected");
            }
            if (isCaptchaPage) {
              logProgress(
                "PAGE_SCRAPING",
                "CAPTCHA detected. Please solve it manually."
              );
              const proceed = await promptUser(
                "Have you solved the CAPTCHA? (y/n): "
              );
              if (!proceed) throw new Error("User aborted after CAPTCHA");
            }

            await page.waitForSelector(".puis-card-container", {
              timeout: 30000,
            });
            await simulateHumanBehavior(page);

            const { productUrls, nextPageUrl } = await page.evaluate(() => {
              const productCards = document.querySelectorAll(
                ".puis-card-container"
              );
              const productUrls = Array.from(productCards)
                .map((card) => {
                  const link = card.querySelector(
                    "a.a-link-normal.s-no-outline"
                  );
                  return link ? link.getAttribute("href") : null;
                })
                .filter((url) => url && url.includes("/dp/"))
                .map((url) =>
                  url.startsWith("http")
                    ? url
                    : `https://www.amazon.com.tr${url}`
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
                const productData = await scrapeProductDetails(
                  productPage,
                  url
                );
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
              await delay(Math.random() * 5000 + 5000);
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
            if (attempt === 2) {
              logProgress(
                "PAGE_SCRAPING",
                `Max retries reached for page ${currentPage}. Restarting browser.`
              );
              await page.close();
              throw new Error("Restart required");
            }
            await delay(15000);
          }
        }

        if (currentUrl) await delay(Math.random() * 15000 + 10000);
      }

      await page.close();
      return; // Success, exit the function
    } catch (error) {
      logProgress(
        "PAGE_SCRAPING",
        `Browser attempt ${browserAttempt + 1} failed: ${error.message}`
      );
      browserAttempt++;
      if (browserAttempt < browserRetries) {
        logProgress("PAGE_SCRAPING", "Restarting browser...");
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        await delay(30000); // Wait longer before restarting
      } else {
        throw new Error("Max browser retries reached");
      }
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

      await scrapePageByPage(
        baseUrl,
        processedUrls,
        productDataArray,
        outputFileName
      );
      logProgress(
        "MAIN",
        `Completed ${baseUrl}: ${productDataArray.length} entries saved to ${outputFileName}`
      );
    }
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
  } finally {
    if (browser && browser.isConnected()) await browser.close();
    logProgress("MAIN", "Browser closed");
    process.exit(0);
  }
};

scrapeAmazonProducts();
