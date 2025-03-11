const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
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
    const maxScrollAttempts = 20;

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
        await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight / 2);
        });
        await delay(500);
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
        document.querySelectorAll(
          "ul.ins-web-smart-recommender-body li.ins-web-smart-recommender-box-item"
        )
      );
      return productElements
        .map((element) => {
          const linkElement = element.querySelector("a.ins-product-box");
          const url = linkElement ? linkElement.getAttribute("href") : null;
          return url ? { url } : null;
        })
        .filter((item) => item !== null);
    });
    console.log(`Found ${items.length} product URLs on current page`);
    return items;
  } catch (error) {
    console.error("Error extracting product URLs:", error);
    return [];
  }
};

const scrapeProductDetails = async (page, url) => {
  try {
    console.log(`Scraping product: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2" });
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
        price = `${decimal}${separator}${fractional}`.trim(); // e.g., "1.049,90"
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
        if (zoomedSrc && zoomedSrc !== "[object Object]") {
          imageSet.add(zoomedSrc);
        } else if (src && src !== "[object Object]") {
          imageSet.add(src);
        }
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
      const categoriesArray = Array.from(breadcrumbItems).map((item) =>
        item.textContent.trim()
      );
      const categories = categoriesArray.join(">");

      // Extract productId from the URL
      const productId = productUrl.split("/").pop(); // e.g., "BP_170637"

      return {
        url: productUrl,
        title, // e.g., "L'Oreal Paris True Match Fondöten No: 1N"
        brand, // e.g., "LOREAL PARIS"
        price,
        currency, // e.g., "₺"
        images, // e.g., "/medias/.../prd-front-170637_1200x1200.jpg;/medias/.../prd-side-170637_1200x1200.jpg;..."
        rating, // e.g., "4.7"
        description, // e.g., product description text
        categories, // e.g., "Ana Sayfa>Makyaj>Yüz Makyajı>Fondöten"
        productId, // e.g., "BP_170637"
      };
    }, url); // Pass the url parameter to page.evaluate

    console.log(
      `Scraped product: ${details.title} by ${details.brand} - ${
        details.price
      } ${details.currency}, Rating: ${details.rating}, Categories: ${
        details.categories
      }, Product ID: ${details.productId}, with ${
        details.images.split(";").length
      } images, Description: ${
        details.description
          ? details.description.substring(0, 50) + "..."
          : "N/A"
      } from ${url}`
    );
    return details;
  } catch (error) {
    console.error(`Error scraping product at ${url}:`, error);
    return {
      url,
      title: null,
      brand: null,
      price: null,
      currency: null,
      images: null,
      rating: null,
      description: null,
      categories: null,
      productId: null,
      error: error.message,
    };
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

  if (fs.existsSync(outputFileName)) {
    try {
      const existingData = fs.readFileSync(outputFileName, "utf8");
      allItems = JSON.parse(existingData);
      console.log(
        `Loaded ${allItems.length} existing items from ${outputFileName}`
      );
    } catch (error) {
      console.error(
        `Error loading existing data from ${outputFileName}:`,
        error
      );
    }
  }

  console.log(`Starting with URL: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  await delay(3000);

  const totalItems = await page.evaluate(() => {
    const totalElement = document.querySelector(
      ".product-grid-manager__view-amount"
    );
    if (totalElement) {
      const text = totalElement.textContent.trim();
      const match = text.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    }
    return 0;
  });
  console.log(`Total items to scrape: ${totalItems}`);

  const lastPage = await page.evaluate(() => {
    const pageLinks = Array.from(
      document.querySelectorAll(".paging__link:not(.paging__link--next)")
    );
    const pageNumbers = pageLinks
      .map((link) => parseInt(link.textContent.trim(), 10))
      .filter((num) => !isNaN(num));
    return Math.max(...pageNumbers) || 1;
  });
  console.log(`Last page number: ${lastPage}`);

  while (!shouldStop) {
    console.log(`Scraping page ${currentPage}...`);
    const items = await extractItems(page);

    if (items.length === 0) {
      console.log("No items found on this page.");
    } else {
      allItems.push(...items);
      fs.writeFileSync(outputFileName, JSON.stringify(allItems, null, 2));
      console.log(`Progress: ${allItems.length}/${totalItems} items collected`);
    }

    if (totalItems && allItems.length >= totalItems) {
      console.log(
        `Reached total item count (${totalItems}). Ending pagination.`
      );
      break;
    }

    if (currentPage >= lastPage) {
      console.log(`Reached last page (${lastPage}). Ending pagination.`);
      break;
    }

    const nextButton = await page.$(".paging__link--next");
    if (!nextButton) {
      console.log("No next button found. Ending pagination.");
      break;
    }

    const isNextDisabled = await page.evaluate((el) => {
      return el.classList.contains("paging__link--disabled");
    }, nextButton);

    if (isNextDisabled) {
      console.log("Next button is disabled. Ending pagination.");
      break;
    }

    await scrollUntilVisible(page, ".paging__link--next");
    console.log(`Navigating to page ${currentPage + 1}`);
    try {
      await Promise.all([
        page.click(".paging__link--next"),
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      ]);
    } catch (error) {
      console.error(`Error navigating to next page: ${error.message}`);
      break;
    }

    await delay(3000);
    currentPage++;
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

      // Scrape individual product details
      const productPage = await browser.newPage();
      const detailedItems = [];
      for (const item of items) {
        const productDetails = await scrapeProductDetails(
          productPage,
          item.url
        );
        detailedItems.push(productDetails);
        fs.writeFileSync(
          outputFileName,
          JSON.stringify(detailedItems, null, 2)
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
