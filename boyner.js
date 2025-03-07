const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const readline = require("readline");

async function scrapeKeyword(page, keyword, productText) {
  try {
    console.log(`Navigating to Trendyol for keyword: ${keyword}`);

    // Navigate to Trendyol
    await page.goto("https://www.trendyol.com/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });

    console.log("Waiting for search input...");

    // Wait for search input
    await page.waitForSelector('input[class*="V8wbcUhU"]', { timeout: 30000 });

    console.log("Typing keyword into search input...");
    await page.type('input[class*="V8wbcUhU"]', keyword);

    console.log("Pressing Enter to search...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
      page.keyboard.press("Enter"),
    ]);

    console.log("Waiting for search results page...");
    await page.waitForSelector('[class*="p-card-wrppr"]', { timeout: 30000 });

    console.log("Starting infinite scroll...");
    await advancedInfiniteScroll(page); // Apply the scrolling fix

    console.log("Extracting product names...");
    const products = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll('[class*="p-card-wrppr"]')
      ).map((product) => {
        const title = product
          .querySelector(".prdct-desc-cntnr-ttl")
          ?.textContent.trim();
        const name = product
          .querySelector(".prdct-desc-cntnr-name")
          ?.textContent.trim();
        const subText = product
          .querySelector(".product-desc-sub-text")
          ?.textContent.trim();
        const fullText = [title, name, subText].filter(Boolean).join(" ");

        return {
          text: fullText,
          link: product.querySelector("a")?.getAttribute("href"),
        };
      });
    });

    console.log("Extracted products:", products);

    // Find the product that matches the text
    const matchingProduct = products.find((product) =>
      product.text.includes(productText)
    );

    if (!matchingProduct) {
      console.log(`Product with text "${productText}" not found.`);
      return;
    }

    console.log(`Found matching product: ${matchingProduct.text}`);
    console.log("Navigating to product page...");

    // Navigate to the product page
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
      page.goto(`https://www.trendyol.com${matchingProduct.link}`),
    ]);

    await page.evaluate(() => {
      const button = document.querySelector(".add-to-basket");
      button?.click();
    });

    await page.waitForTimeout(5000);
    console.log("Product added to basket.");
  } catch (error) {
    console.error(`Error processing keyword ${keyword}:`, error);
  }
}

async function advancedInfiniteScroll(page) {
  console.log("Starting advanced infinite scroll...");

  const totalExpectedProducts = await page.evaluate(() => {
    const totalElement = document.querySelector(".product-list_total__TvMCW");
    if (totalElement) {
      const match = totalElement.textContent.match(/\d+/);
      return match ? parseInt(match[0], 10) : 500;
    }
    return 500; // Default fallback
  });

  console.log(`Expected total products: ${totalExpectedProducts}`);

  let lastProductCount = 0;
  let noChangeCount = 0;
  let pageCounter = 1; // Track virtual pages
  const maxNoChangeRetries = 3;

  const slowScroll = async () => {
    await page.evaluate(async () => {
      return new Promise((resolve) => {
        let scrollStep = 100;
        let scrollInterval = setInterval(() => {
          window.scrollBy(0, scrollStep);
          if (
            window.innerHeight + window.scrollY >=
            document.body.scrollHeight
          ) {
            clearInterval(scrollInterval);
            resolve();
          }
        }, 200);
      });
    });
    await delay(2000);
  };

  while (noChangeCount < maxNoChangeRetries) {
    await slowScroll();

    if (pageCounter >= 13) {
      console.log("Reached page 13, adding extra delay...");
      await delay(5000);
    }

    // Click "Show More" button if available
    const hasMoreButton = await page.evaluate(() => {
      const showMoreBtn = document.querySelector(
        ".product-list_showMoreButton__eS2_Z"
      );
      if (showMoreBtn && showMoreBtn.offsetParent !== null) {
        showMoreBtn.click();
        return true;
      }
      return false;
    });

    if (hasMoreButton) {
      console.log("Clicked 'Show More' button");
      await delay(4000);
    }

    const currentProductCount = await page.evaluate(() => {
      return document.querySelectorAll(".listProductItem").length;
    });

    console.log(
      `Found ${currentProductCount} / ${totalExpectedProducts} products`
    );

    if (currentProductCount === lastProductCount) {
      noChangeCount++;
      console.log(
        `No new products loaded. Retry ${noChangeCount}/${maxNoChangeRetries}`
      );

      if (noChangeCount >= maxNoChangeRetries) {
        console.log("Page might be stuck. Refreshing...");
        await page.reload({ waitUntil: "networkidle2" });
        await delay(5000);
        noChangeCount = 0;
      } else {
        await page.evaluate(() => {
          window.scrollBy(0, -200);
        });
        await delay(500);
        await page.evaluate(() => {
          window.scrollBy(0, 200);
        });
        await delay(2000);
      }
    } else {
      noChangeCount = 0;
      pageCounter++;
    }

    lastProductCount = currentProductCount;

    if (currentProductCount >= totalExpectedProducts) {
      console.log("Found all expected products!");
      break;
    }
  }

  const finalProductCount = await page.evaluate(() => {
    return document.querySelectorAll(".listProductItem").length;
  });

  console.log(
    `Finished scrolling. Found ${finalProductCount} products in total.`
  );
}

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Trendyol Multi-Product Scraper ===");

  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 60000,
  });

  try {
    const page = await browser.newPage();
    page.on("console", (msg) => console.log("Browser Console:", msg.text()));

    await scrapeKeyword(page, "iphone", "Apple iPhone 15");

    await browser.close();
    console.log("Scraping completed.");
  } catch (error) {
    console.error("Main process error:", error);
    await browser.close();
  }
}

main().catch(console.error);
