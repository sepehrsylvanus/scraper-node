const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const outputDir = path.join(__dirname, "output", "watsons");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

let browser;
let shouldStop = false;

const today = new Date("2025-03-10");
const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
  2,
  "0"
)}-${String(today.getDate()).padStart(2, "0")}`; // "2025-03-10"

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const scrollUntilVisible = async (page, selector) => {
  try {
    let isVisible = false;
    let scrollAttempts = 0;
    const maxScrollAttempts = 30;

    while (!isVisible && scrollAttempts < maxScrollAttempts) {
      const element = await page.$(selector);
      if (!element) {
        console.log(
          `Element with selector ${selector} not found after ${scrollAttempts} attempts.`
        );
        return false;
      }

      const isElementVisible = await page.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      }, element);

      if (isElementVisible) {
        isVisible = true;
      } else {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight / 2));
        await delay(1000);
        scrollAttempts++;
      }
    }
    return isVisible;
  } catch (error) {
    console.error(
      `Error in scrollUntilVisible for selector ${selector}:`,
      error
    );
    return false;
  }
};

const extractItems = async (page) => {
  try {
    const items = await page.evaluate(() => {
      const productElements = Array.from(
        document.querySelectorAll("div.product-tile")
      );
      return productElements
        .map((element) => {
          const linkElement = element.querySelector(
            "div.product-tile__image-container a.product-tile__link"
          );
          const relativeUrl = linkElement
            ? linkElement.getAttribute("href")
            : null;
          const url = relativeUrl
            ? `https://www.watsons.com.tr${relativeUrl}`
            : null;

          const stockButton = element.querySelector(
            ".product-tile__button button"
          );
          const stockText = stockButton ? stockButton.textContent.trim() : null;
          const existence =
            stockText && stockText.includes("Sepete Ekle") ? true : false;

          return url ? { url, existence } : null;
        })
        .filter((item) => item !== null);
    });
    console.log(`Extracted ${items.length} product URLs from current page`);
    items.forEach((item, index) =>
      console.log(`Item ${index + 1}: ${item.url}, In Stock: ${item.existence}`)
    );
    return items;
  } catch (error) {
    console.error("Error extracting product URLs and existence:", error);
    return [];
  }
};

const scrapeProductDetails = async (page, item, retries = 2) => {
  const { url, existence } = item;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      console.log(
        `Scraping product (Attempt ${attempt}/${retries + 1}): ${url}`
      );
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await delay(2000);

      const details = await page.evaluate((productUrl) => {
        const priceElement = document.querySelector(
          ".formatted-price.formatted-price--currency-last"
        );
        let price = null;
        let currency = null;
        if (priceElement) {
          currency =
            priceElement
              .querySelector(".formatted-price__currency")
              ?.textContent.trim() || null;
          const decimal =
            priceElement
              .querySelector(".formatted-price__decimal")
              ?.textContent.trim() || "";
          const separator =
            priceElement
              .querySelector(".formatted-price__separator")
              ?.textContent.trim() || "";
          const fractional =
            priceElement
              .querySelector(".formatted-price__fractional")
              ?.textContent.trim() || "";
          price = `${decimal}${separator}${fractional}`.trim();
        }

        const titleElement = document.querySelector(".product__title-name");
        const title = titleElement ? titleElement.textContent.trim() : null;

        const brandElement = document.querySelector(
          ".pdp__accordion-title strong"
        );
        const brand = brandElement ? brandElement.textContent.trim() : null;

        const imageElements = document.querySelectorAll(
          ".product-thumbnails__slot img"
        );
        const imageSet = new Set();
        imageElements.forEach((img) => {
          const zoomedSrc = img.getAttribute("data-zoomed-src");
          const src = img.getAttribute("src");
          if (zoomedSrc && zoomedSrc !== "[object Object]")
            imageSet.add(zoomedSrc);
          else if (src && src !== "[object Object]") imageSet.add(src);
        });
        const images = Array.from(imageSet).join(";");

        const ratingElement = document.querySelector(".reviews-average-rating");
        const rating = ratingElement ? ratingElement.textContent.trim() : null;

        const descriptionElement = document.querySelector(
          ".product-information__text"
        );
        const description = descriptionElement
          ? descriptionElement.textContent.trim()
          : null;

        const breadcrumbItems = document.querySelectorAll(
          ".e2-breadcrumbs__items .e2-breadcrumbs__link"
        );
        const categories = Array.from(breadcrumbItems)
          .map((item) => item.textContent.trim())
          .join(">");

        const productId = productUrl.split("/").pop();

        return {
          url: productUrl,
          title,
          brand,
          price,
          currency,
          images,
          rating,
          description,
          categories,
          productId,
        };
      }, url);

      const fullDetails = { ...details, existence };
      console.log(
        `Scraped product: ${fullDetails.title || "Unknown"} - Existence: ${
          fullDetails.existence
        }`
      );
      return fullDetails;
    } catch (error) {
      console.error(
        `Error scraping product at ${url} (Attempt ${attempt}/${retries + 1}):`,
        error
      );
      if (attempt === retries + 1) {
        return { url, existence, error: error.message };
      }
      await delay(3000);
    }
  }
};

const scrapePagination = async (page, baseUrl) => {
  let currentPage = 1;
  const urlParts = baseUrl.split("?");
  const baseUrlWithoutPage = urlParts[0];
  const outputFileName = path.join(
    outputDir,
    `${baseUrlWithoutPage
      .replace(/https?:\/\/|www\.|\.com\//g, "")
      .replace(/\//g, "_")}_${dateStr}.json`
  );

  let allItems = [];

  console.log(`Starting with URL: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2", timeout: 60000 });
  await delay(3000);

  // Handle cookie consent modal
  const acceptButtonSelector = "#onetrust-accept-btn-handler";
  try {
    await page.waitForSelector(acceptButtonSelector, { timeout: 10000 });
    console.log("Cookie consent modal detected. Clicking 'kabul et'...");
    await page.click(acceptButtonSelector);
    await delay(1000);
    console.log("Modal closed successfully.");
  } catch (error) {
    console.error(
      "Error handling cookie consent modal or modal not found:",
      error
    );
  }

  const totalItems = await page.evaluate(() => {
    const totalElement = document.querySelector(
      ".product-grid-manager__view-amount"
    );
    return totalElement
      ? parseInt(totalElement.textContent.match(/(\d+)/)?.[1] || 0, 10)
      : 0;
  });
  console.log(`Total items to scrape: ${totalItems}`);

  const lastPage = await page.evaluate(() => {
    const pageLinks = Array.from(
      document.querySelectorAll(".paging__link:not(.paging__link--next)")
    );
    const pageNumbers = pageLinks
      .map((link) => parseInt(link.textContent.trim(), 10))
      .filter((num) => !isNaN(num));
    return Math.max(...pageNumbers, 1);
  });
  console.log(`Last page number: ${lastPage}`);

  while (!shouldStop && currentPage <= lastPage) {
    console.log(
      `Scraping page ${currentPage} (Items collected so far: ${allItems.length}/${totalItems})`
    );

    // Scroll from top to bottom to load all items
    let previousHeight = 0;
    let currentHeight = await page.evaluate(() => document.body.scrollHeight);
    while (previousHeight < currentHeight) {
      await page.evaluate(() => window.scrollBy(0, 500));
      await delay(3000);
      previousHeight = currentHeight;
      currentHeight = await page.evaluate(() => document.body.scrollHeight);
    }

    // Extract items from current page
    const pageItems = await extractItems(page);
    console.log(`Page ${currentPage} yielded ${pageItems.length} items`);

    if (pageItems.length === 0) {
      console.warn(
        `No items extracted from page ${currentPage}. Check selectors or page load.`
      );
    }

    // Add items to allItems
    allItems.push(...pageItems);
    console.log(
      `Cumulative progress after page ${currentPage}: ${allItems.length}/${totalItems} items`
    );

    if (allItems.length >= totalItems) {
      console.log(
        `Reached or exceeded total item count (${totalItems}). Ending pagination.`
      );
      break;
    }

    const nextButtonSelector = ".paging__link--next";
    const visible = await scrollUntilVisible(page, nextButtonSelector);
    if (!visible) {
      console.log(
        `Next button not visible on page ${currentPage}. Ending pagination.`
      );
      break;
    }

    const nextButton = await page.$(nextButtonSelector);
    if (!nextButton) {
      console.log(
        `No next button found on page ${currentPage}. Ending pagination.`
      );
      break;
    }

    const isNextDisabled = await page.evaluate(
      (el) => el.classList.contains("paging__link--disabled"),
      nextButton
    );
    if (isNextDisabled) {
      console.log(
        `Next button disabled on page ${currentPage}. Ending pagination.`
      );
      break;
    }

    console.log(`Clicking next button on page ${currentPage}`);
    try {
      await page.click(nextButtonSelector);
      await page.waitForFunction(
        () => document.querySelectorAll("div.product-tile").length > 0,
        { timeout: 60000 }
      );
      await delay(3000);

      // Scroll from top again after navigation
      await page.evaluate(() => window.scrollTo(0, 0));
      await delay(1000);
      previousHeight = 0;
      currentHeight = await page.evaluate(() => document.body.scrollHeight);
      while (previousHeight < currentHeight) {
        await page.evaluate(() => window.scrollBy(0, 500));
        await delay(3000);
        previousHeight = currentHeight;
        currentHeight = await page.evaluate(() => document.body.scrollHeight);
      }
    } catch (error) {
      console.error(
        `Error navigating to next page from page ${currentPage}:`,
        error
      );
      break;
    }

    currentPage++;
  }

  if (allItems.length < totalItems) {
    console.warn(
      `Collected ${allItems.length} items, expected ${totalItems}. Some items missing.`
    );
  }

  console.log(
    `Pagination finished for ${baseUrl}. Collected ${allItems.length} out of ${totalItems} items.`
  );
  return { items: allItems, outputFileName };
};

const scrapeMultipleUrls = async () => {
  const urls = process.argv.slice(2);

  if (urls.length === 0) {
    console.error(
      "No URLs provided. Usage: node script.js <url1> <url2> <url3> ..."
    );
    process.exit(1);
  }

  try {
    browser = await launchBrowser();

    for (const baseUrl of urls) {
      console.log(`Starting scraping for: ${baseUrl}`);
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      const { items, outputFileName } = await scrapePagination(page, baseUrl);
      await page.close();

      const productPage = await browser.newPage();
      const detailedItems = [];
      const totalItems = items.length;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        console.log(`Processing product ${i + 1}/${totalItems}: ${item.url}`);
        const productDetails = await scrapeProductDetails(productPage, item);
        detailedItems.push(productDetails);
      }

      fs.writeFileSync(outputFileName, JSON.stringify(detailedItems, null, 2));
      console.log(
        `Saved ${detailedItems.length}/${totalItems} detailed items to ${outputFileName}`
      );

      if (detailedItems.length < totalItems) {
        console.warn(
          `Final JSON has ${detailedItems.length} items, expected ${totalItems}.`
        );
      } else {
        console.log(
          `Successfully saved all ${detailedItems.length} products to ${outputFileName}`
        );
      }

      await productPage.close();
      console.log(`Finished scraping for: ${baseUrl}\n`);
      shouldStop = false;
    }

    await browser.close();
    console.log("All URLs processed successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Error during scraping:", error);
    if (browser) await browser.close();
    process.exit(1);
  }
};

process.on("SIGINT", async () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  shouldStop = true;
  if (browser) await browser.close();
  process.exit(0);
});

scrapeMultipleUrls();
