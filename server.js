const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const outputFilePath = path.join(__dirname, "products.json");
let browser, page;
let shouldStop = false;

// Enable keyboard interrupt handling
readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Capture 'q' key press
process.stdin.on("data", (key) => {
  if (key.toString().trim().toLowerCase() === "q") {
    console.log("\nReceived quit signal. Stopping scraping...");
    shouldStop = true;
  }
});

// Make sure stdin is in raw mode to capture key presses
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isElementInViewport = async (page, selector) => {
  return await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <=
        (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
  }, selector);
};

const launchBrowser = async () => {
  try {
    if (browser && browser.isConnected()) return browser;
    return await puppeteer.launch({
      headless: false,
      protocolTimeout: 86400000,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  } catch (error) {
    console.error("Error launching browser:", error);
    throw error;
  }
};

const advancedInfiniteScroll = async (page) => {
  console.log("Starting advanced infinite scroll...");
  return await page.evaluate(async () => {
    return await new Promise((resolve) => {
      let totalHeight = 0;
      const scrollDistance = 1000;
      const maxScrollAttempts = 20;
      let scrollAttempts = 0;
      let lastHeight = document.body.scrollHeight;

      const scrollInterval = setInterval(() => {
        // Scroll down
        window.scrollBy(0, scrollDistance);
        totalHeight += scrollDistance;
        scrollAttempts++;

        // Check for new content loading
        const currentHeight = document.body.scrollHeight;
        const newContentLoaded = currentHeight > lastHeight;

        // Check for RFM marquee or other lazy load indicators
        const marqueeVisible = document.querySelector(".rfm-marquee") !== null;

        if (newContentLoaded) {
          console.log("New content detected!");
          lastHeight = currentHeight;
          scrollAttempts = 0; // Reset attempts when new content is found
        }

        // Stop conditions
        if (
          scrollAttempts >= maxScrollAttempts ||
          totalHeight >= currentHeight * 2
        ) {
          clearInterval(scrollInterval);
          resolve(true);
        }
      }, 500);
    });
  });
};

const scrapeProducts = async () => {
  try {
    browser = await launchBrowser();
    page = await browser.newPage();
    const url = process.argv[2];

    if (!url) {
      console.error("Please provide a URL as an argument");
      process.exit(1);
    }

    // Configure page to load faster and handle lazy loading
    await page.setDefaultNavigationTimeout(120000);
    await page.setDefaultTimeout(120000);

    await page.goto(url, {
      waitUntil: ["networkidle0", "domcontentloaded"],
      timeout: 120000,
    });
    console.log("Navigated to the page");
    console.log("Press 'q' at any time to stop scraping");

    // Scroll and wait for content to load
    await advancedInfiniteScroll(page);
    await delay(5000);

    let products = [];
    let scrapedProductUrls = new Set();
    let productCounter = 0;
    const MAX_ITERATIONS = 20;
    let iterations = 0;

    while (!shouldStop && iterations < MAX_ITERATIONS) {
      console.log(`Iteration ${iterations + 1}`);

      // Check if RFM marquee is visible and trigger additional scrolling
      const isMarqueeVisible = await isElementInViewport(page, ".rfm-marquee");
      if (isMarqueeVisible) {
        console.log("RFM Marquee detected. Attempting additional scroll.");
        await advancedInfiniteScroll(page);
        await delay(3000);
      }

      const content = await page.content();
      const $ = cheerio.load(content);
      const elements = $(".listProductItem");

      console.log(`Total product elements found: ${elements.length}`);

      for (const element of elements) {
        if (shouldStop) break;

        const productUrl =
          "https://www.boyner.com.tr/" +
          $(element).find(".product-item_image__IxD4T a").attr("href");

        if (scrapedProductUrls.has(productUrl)) continue;

        let productPage;
        try {
          productPage = await browser.newPage();
          await productPage.goto(productUrl, {
            waitUntil: "networkidle2",
            timeout: 120000,
          });

          // Your existing product scraping logic
          const product = {
            // Your product object construction
            // Ensure this matches your previous implementation
          };

          console.log(`Processing product: ${product.title}`);
          products.push(product);
          scrapedProductUrls.add(productUrl);

          // Save products to file periodically
          fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));

          await productPage.close();
          productCounter++;
        } catch (productError) {
          console.error(`Error processing product: ${productUrl}`);
          console.error(productError.message);
          if (productPage) await productPage.close();
        }
      }

      // Scroll and wait for potential new content
      await advancedInfiniteScroll(page);
      await delay(3000);

      iterations++;
      console.log(`Total products processed so far: ${productCounter}`);

      // Additional stop condition if no progress
      if (iterations >= MAX_ITERATIONS) {
        console.log("Reached maximum iterations. Stopping scraping.");
        break;
      }

      if (shouldStop) break;
    }

    console.log(`Total products processed: ${productCounter}`);

    // Save final results
    fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));

    await browser.close();
    process.exit(0);
  } catch (error) {
    console.log("Error encountered:", error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
};

scrapeProducts();
