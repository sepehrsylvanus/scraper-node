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
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
};

// Fetch proxies from ProxyScrape API - with fallback to direct connection
const fetchProxies = async () => {
  try {
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
        .on("error", (err) => {
          logProgress("PROXY", `Error fetching proxies: ${err.message}`);
          resolve([]); // Return empty array on error
        });
    });
  } catch (error) {
    logProgress("PROXY", `Failed to fetch proxies: ${error.message}`);
    return []; // Return empty array on any error
  }
};

// Launch browser with proxy or direct connection
const launchBrowser = async (proxies, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const args = [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--start-maximized",
        "--disable-features=IsolateOrigins",
        "--disable-site-isolation-trials",
        "--disable-web-security",
      ];

      let proxy = null;
      if (proxies && proxies.length) {
        proxy = proxies[Math.floor(Math.random() * proxies.length)];
        args.push(`--proxy-server=${proxy}`);
        logProgress(
          "BROWSER",
          `Launching browser with proxy ${proxy} (attempt ${i + 1})...`
        );
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
        ignoreHTTPSErrors: true,
      });

      const pages = await browser.pages();
      const tempPage = pages[0] || (await browser.newPage());
      await tempPage.setUserAgent(getRandomUserAgent());

      // Test connection by accessing a simple page
      await tempPage.goto("https://www.google.com", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      logProgress("BROWSER", "Browser launched successfully");
      return browser;
    } catch (error) {
      logProgress(
        "BROWSER",
        `Browser launch attempt ${i + 1} failed: ${error.message}`
      );
      if (browser) {
        try {
          await browser.close();
        } catch (e) {
          logProgress("BROWSER", `Error closing browser: ${e.message}`);
        }
      }

      if (i === retries - 1) {
        throw new Error(
          `Failed to launch browser after ${retries} attempts: ${error.message}`
        );
      }
      await delay(3000);
    }
  }
};

// Configure page to bypass anti-bot measures
const configurePage = async (page) => {
  await page.setUserAgent(getRandomUserAgent());
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9,tr;q=0.8",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Sec-CH-UA":
      '"Not_A Brand";v="99", "Google Chrome";v="109", "Chromium";v="109"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  });

  // Disable JavaScript detection for bots
  await page.evaluateOnNewDocument(() => {
    // Override the navigator properties
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
    });

    // Override plugins
    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer" },
        {
          name: "Chrome PDF Viewer",
          filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
        },
        { name: "Native Client", filename: "internal-nacl-plugin" },
      ],
    });

    // Override languages
    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en", "tr"],
    });

    // Add WebGL fingerprinting
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) {
        return "Intel Inc.";
      }
      if (parameter === 37446) {
        return "Intel Iris OpenGL Engine";
      }
      return getParameter.apply(this, arguments);
    };
  });
};

// Scrape product details
const scrapeProductDetails = async (page, url, retries = 3) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await configurePage(page);

      // Try to navigate to the product page
      await page.goto(url, {
        waitUntil: "networkidle2",
        timeout: 60000,
      });

      // Wait for content to load - check multiple selectors
      await Promise.race([
        page.waitForSelector("#productTitle", { timeout: 20000 }),
        page.waitForSelector(".product-title-word-break", { timeout: 20000 }),
        page.waitForSelector("[data-feature-name='title']", { timeout: 20000 }),
      ]);

      // Check for CAPTCHA and handle it
      const isCaptcha = await page.evaluate(() => {
        return (
          document.body.textContent.includes(
            "To discuss automated access to Amazon data please contact"
          ) ||
          document.body.textContent.includes(
            "Enter the characters you see below"
          ) ||
          document.body.textContent.includes(
            "type the characters you see in this image"
          )
        );
      });

      if (isCaptcha) {
        logProgress(
          "PRODUCT_SCRAPING",
          "CAPTCHA detected! Waiting for manual input..."
        );
        await page.screenshot({ path: `captcha_${Date.now()}.png` });
        await delay(30000); // Wait for manual CAPTCHA entry
      }

      const productData = await page.evaluate(() => {
        // Helper function to safely extract text
        const getText = (selector) => {
          const element = document.querySelector(selector);
          return element ? element.textContent.trim() : null;
        };

        // Try multiple price selectors
        let price = null;
        let currency = "";

        // Try the first price format
        const wholePriceElement = document.querySelector("span.a-price-whole");
        const fractionPriceElement = document.querySelector(
          "span.a-price-fraction"
        );
        const currencyElement = document.querySelector("span.a-price-symbol");

        if (wholePriceElement && fractionPriceElement) {
          const wholePriceText = wholePriceElement.textContent.replace(
            /[^\d]/g,
            ""
          );
          const fractionPrice = fractionPriceElement.textContent
            .replace(/[^\d]/g, "")
            .padStart(2, "0");
          currency = currencyElement ? currencyElement.textContent.trim() : "₺"; // Default to TL for TR
          price = parseFloat(`${wholePriceText}.${fractionPrice}`);
        }

        // Alternative price selector
        if (!price) {
          const priceElement = document.querySelector(".a-price .a-offscreen");
          if (priceElement) {
            const priceText = priceElement.textContent.trim();
            // Extract currency symbol and value
            const match = priceText.match(/([^\d]*)(\d+)[,.](\d+)/);
            if (match) {
              currency = match[1].trim();
              price = parseFloat(`${match[2]}.${match[3]}`);
            }
          }
        }

        // Extract product ID from URL or page
        let productId = "";
        const productIdMatch =
          window.location.href.match(/\/dp\/([A-Z0-9]{10})/);
        if (productIdMatch) {
          productId = productIdMatch[1];
        }

        // Extract brand from multiple possible locations
        let brand = "";
        // Try tech specs table
        const techTableRows = document.querySelectorAll(
          "#productDetails_techSpec_section_1 tr, .prodDetTable tr"
        );
        for (const row of techTableRows) {
          const th = row.querySelector("th");
          const td = row.querySelector("td");
          if (
            th &&
            td &&
            (th.textContent.trim().includes("Marka") ||
              th.textContent.trim().includes("Brand"))
          ) {
            brand = td.textContent.trim().replace(/‎/g, "");
            break;
          }
        }

        // Try brand element if not found in table
        if (!brand) {
          const brandElement = document.querySelector(
            "#bylineInfo, .a-link-normal.contributorNameID"
          );
          if (brandElement) {
            brand = brandElement.textContent
              .trim()
              .replace(/^by\s+|\s+Brand:\s+/i, "");
          }
        }

        // Extract title
        const title =
          getText("#productTitle") ||
          getText(".product-title-word-break") ||
          "";

        // Extract images
        const images = Array.from(
          document.querySelectorAll(
            "#altImages .imageThumbnail img, #altImages .videoThumbnail img, .image-block img"
          )
        )
          .map(
            (img) =>
              img.getAttribute("src") || img.getAttribute("data-old-hires")
          )
          .filter((src) => src && typeof src === "string")
          .filter((src, i, arr) => src && arr.indexOf(src) === i)
          .join(";");

        // Extract rating
        let rating = null;
        const ratingText =
          getText("#acrPopover .a-size-base.a-color-base") ||
          getText(".a-icon-star-small .a-icon-alt");
        if (ratingText) {
          const ratingMatch = ratingText.match(/(\d+[.,]\d+)/);
          rating = ratingMatch
            ? parseFloat(ratingMatch[1].replace(",", "."))
            : null;
        }

        // Extract specifications
        const specifications = [];
        const specTables = document.querySelectorAll(
          "#productDetails_techSpec_section_1, .prodDetTable, #technicalSpecifications_section_1"
        );
        for (const table of specTables) {
          const rows = table.querySelectorAll("tr");
          for (const row of rows) {
            const name = row.querySelector("th")?.textContent.trim() || "";
            const value =
              row.querySelector("td")?.textContent.trim().replace(/‎/g, "") ||
              "";
            if (name && value) {
              specifications.push({ name, value });
            }
          }
        }

        // Extract categories
        const categories = Array.from(
          document.querySelectorAll(
            "#wayfinding-breadcrumbs_feature_div .a-unordered-list.a-horizontal li a, .a-breadcrumb li a"
          )
        )
          .map((el) => el.textContent.trim())
          .join(">");

        // Extract description
        const descriptionItems = Array.from(
          document.querySelectorAll(
            "#feature-bullets ul.a-unordered-list li span.a-list-item, #productDescription p, #aplus p"
          )
        )
          .map((item) => item.textContent.trim())
          .filter((text) => text.length > 0);

        const description = descriptionItems.join("\n");

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

      // Take screenshot for debugging
      try {
        await page.screenshot({ path: `error_product_${Date.now()}.png` });
      } catch (e) {
        logProgress(
          "PRODUCT_SCRAPING",
          `Failed to take error screenshot: ${e.message}`
        );
      }

      if (attempt === retries - 1) {
        logProgress("PRODUCT_SCRAPING", `All retries failed for ${url}`);
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
      await delay(Math.random() * 3000 + 2000); // Longer delay between retries
    }
  }
};

// Save data to file
const saveUrlsToFile = (data, filePath) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    logProgress("FILE", `Saved ${data.length} product entries to ${filePath}`);
  } catch (error) {
    logProgress("FILE", `Error saving to ${filePath}: ${error.message}`);
    // Create backup file
    const backupPath = `${filePath}.backup-${Date.now()}.json`;
    fs.writeFileSync(backupPath, JSON.stringify(data, null, 2));
    logProgress("FILE", `Created backup at ${backupPath}`);
  }
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
  const maxPages = 10;
  let currentUrl = baseUrl;

  await configurePage(page);

  while (currentPage <= maxPages && currentUrl) {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        logProgress(
          "PAGE_SCRAPING",
          `Navigating to page ${currentPage}: ${currentUrl}`
        );

        // Go to the search results page
        await page.goto(currentUrl, {
          waitUntil: "networkidle2",
          timeout: 60000,
        });

        // Check for CAPTCHA
        const isCaptcha = await page.evaluate(() => {
          return (
            document.body.textContent.includes(
              "To discuss automated access to Amazon data please contact"
            ) ||
            document.body.textContent.includes(
              "Enter the characters you see below"
            ) ||
            document.body.textContent.includes(
              "type the characters you see in this image"
            )
          );
        });

        if (isCaptcha) {
          logProgress(
            "PAGE_SCRAPING",
            "CAPTCHA detected! Waiting for manual input..."
          );
          await page.screenshot({ path: `captcha_page_${Date.now()}.png` });
          await delay(30000); // Wait for manual CAPTCHA entry
        }

        // Wait for product cards to load - try multiple selectors for different Amazon layouts
        await Promise.race([
          page.waitForSelector(".puis-card-container", { timeout: 20000 }),
          page.waitForSelector(".s-result-item", { timeout: 20000 }),
          page.waitForSelector("[data-component-type='s-search-result']", {
            timeout: 20000,
          }),
        ]);

        // Screenshot for debugging (optional)
        await page.screenshot({
          path: `page_${currentPage}_${Date.now()}.png`,
        });

        const { productUrls, nextPageUrl } = await page.evaluate(() => {
          // Try multiple selectors for product cards
          const productElements = Array.from(
            document.querySelectorAll(
              ".puis-card-container a.a-link-normal.s-no-outline, .s-result-item a.a-link-normal.s-no-outline, [data-component-type='s-search-result'] h2 a"
            )
          );

          const productUrls = productElements
            .map((link) => link.getAttribute("href"))
            .filter(
              (url) => url && (url.includes("/dp/") || url.includes("/gp/"))
            )
            .map((url) => {
              // Clean up URL to get consistent format
              let cleanUrl = url;
              if (!url.startsWith("http")) {
                cleanUrl = `https://www.amazon.com.tr${url}`;
              }
              // Extract ASIN and build canonical URL
              const asinMatch = url.match(/\/(dp|gp)\/([A-Z0-9]{10})/);
              if (asinMatch) {
                return `https://www.amazon.com.tr/dp/${asinMatch[2]}`;
              }
              return cleanUrl;
            });

          // Look for next page button
          const nextButtons = [
            document.querySelector(
              'a.s-pagination-item.s-pagination-next[aria-label^="Sonraki"]'
            ),
            document.querySelector("a.s-pagination-item.s-pagination-next"),
            document.querySelector("li.a-last a"),
          ];

          let nextPageUrl = null;
          for (const btn of nextButtons) {
            if (btn && !btn.classList.contains("s-pagination-disabled")) {
              nextPageUrl = btn.getAttribute("href");
              if (nextPageUrl && !nextPageUrl.startsWith("http")) {
                nextPageUrl = `https://www.amazon.com.tr${nextPageUrl}`;
              }
              break;
            }
          }

          return {
            productUrls: [...new Set(productUrls)], // Remove duplicates
            nextPageUrl,
          };
        });

        logProgress(
          "PAGE_SCRAPING",
          `Found ${productUrls.length} product URLs on page ${currentPage}`
        );

        if (productUrls.length === 0) {
          // If no products found but no error, take screenshot and log
          await page.screenshot({
            path: `no_products_page${currentPage}_${Date.now()}.png`,
          });
          logProgress(
            "PAGE_SCRAPING",
            "No product URLs found on page. Check screenshot for details."
          );

          if (attempt === retries - 1) {
            logProgress(
              "PAGE_SCRAPING",
              `Max retries reached for page ${currentPage}. Moving on.`
            );
            currentUrl = null;
            break;
          }
        } else {
          // Process products
          for (const url of productUrls) {
            if (processedUrls.has(url)) {
              logProgress(
                "PAGE_SCRAPING",
                `Skipping already processed URL: ${url}`
              );
              continue;
            }

            const productData = await scrapeProductDetails(page, url);
            if (productData.title) {
              // Only add if we got data
              productDataArray.push(productData);
              processedUrls.add(url);
              logProgress("PAGE_SCRAPING", `Scraped ${url} successfully`);

              // Save after each product to avoid losing data
              saveUrlsToFile(productDataArray, outputFileName);
            }

            // Random delay between products
            await delay(Math.random() * 3000 + 2000);
          }

          currentUrl = nextPageUrl;
          currentPage++;
          break; // Move to next page
        }
      } catch (error) {
        logProgress(
          "PAGE_SCRAPING",
          `Attempt ${attempt + 1} failed for page ${currentPage}: ${
            error.message
          }`
        );

        // Take screenshot for debugging
        try {
          await page.screenshot({
            path: `error_page${currentPage}_${Date.now()}.png`,
          });
        } catch (e) {
          logProgress(
            "PAGE_SCRAPING",
            `Failed to take error screenshot: ${e.message}`
          );
        }

        if (attempt === retries - 1) {
          logProgress(
            "PAGE_SCRAPING",
            `Max retries reached for page ${currentPage}. Moving on.`
          );
          currentUrl = null;
          break;
        }
        await delay(Math.random() * 5000 + 3000);
      }
    }
    if (currentUrl) await delay(Math.random() * 5000 + 3000);
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
  } catch (error) {
    console.error("[FATAL] Fatal error:", error);
  } finally {
    if (browser) {
      try {
        await browser.close();
        logProgress("MAIN", "Browser closed");
      } catch (err) {
        console.error("Error closing browser:", err);
      }
    }
    process.exit(0);
  }
};

scrapeAmazonProducts();
