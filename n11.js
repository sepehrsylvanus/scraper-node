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

const extractProductUrls = async (page) => {
  return await page.evaluate(() => {
    const productElements = document.querySelectorAll(".columnContent");
    return Array.from(productElements)
      .map((element) => {
        const linkElement = element.querySelector("a[href]");
        return linkElement ? linkElement.getAttribute("href") : null;
      })
      .filter((url) => url !== null);
  });
};

const scrollAndLoad = async (page, baseUrl) => {
  console.log(`Starting scroll for: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  await delay(3000);

  const totalProducts = await page.evaluate(() => {
    const resultElement = document.querySelector(
      ".listOptionHolder .resultText strong"
    );
    return resultElement ? parseInt(resultElement.textContent.trim(), 10) : 0;
  });
  console.log(`Total products expected: ${totalProducts}`);

  let loadedProducts = 0;
  let scrollPosition = 0;

  while (!shouldStop) {
    await page.evaluate((pos) => {
      window.scrollTo(0, pos);
    }, scrollPosition);
    scrollPosition += 500;
    await delay(1000);

    const currentProducts = await page.evaluate(() => {
      return document.querySelectorAll(".columnContent").length;
    });
    console.log(
      `Loaded products: ${currentProducts}/${totalProducts} at scroll position: ${scrollPosition}`
    );

    const feedbackAreaVisible = await page.evaluate(() => {
      const feedbackArea = document.querySelector(".feedback-area");
      if (feedbackArea) {
        const rect = feedbackArea.getBoundingClientRect();
        return rect.top >= 0 && rect.top <= window.innerHeight;
      }
      return false;
    });

    if (feedbackAreaVisible) {
      console.log(
        "Reached feedback-area, waiting 10 seconds for new products..."
      );
      await delay(10000);

      const newProductCount = await page.evaluate(() => {
        return document.querySelectorAll(".columnContent").length;
      });
      console.log(
        `New product count after waiting: ${newProductCount}/${totalProducts}`
      );
      loadedProducts = newProductCount;

      if (loadedProducts < totalProducts) {
        console.log("Not enough products loaded, scrolling back to top...");
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await delay(2000);
        scrollPosition = 0;
        console.log("Scrolling down again...");
      }
    } else {
      loadedProducts = currentProducts;
    }

    if (loadedProducts >= totalProducts) {
      console.log(`All ${totalProducts} products loaded. Stopping scroll.`);
      break;
    }

    const documentHeight = await page.evaluate(
      () => document.body.scrollHeight
    );
    if (scrollPosition >= documentHeight) {
      console.log("Reached end of page.");
      if (loadedProducts < totalProducts) {
        console.log("Not enough products, scrolling back to top...");
        await page.evaluate(() => {
          window.scrollTo(0, 0);
        });
        await delay(2000);
        scrollPosition = 0;
        console.log("Scrolling down again...");
      } else {
        console.log("All products loaded despite reaching end.");
        break;
      }
    }
  }

  const productUrls = await extractProductUrls(page);
  console.log(`Collected ${productUrls.length} product URLs.`);

  return productUrls;
};

const scrapeProductDetails = async (page, url) => {
  try {
    console.log(`Opening product page: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2" });
    await delay(2000);

    const details = await page.evaluate(() => {
      // Extract title
      const titleElement = document.querySelector(".unf-p-title .proName");
      const title = titleElement ? titleElement.textContent.trim() : null;

      // Extract brand
      let brand = null;
      const propItems = document.querySelectorAll(".unf-prop-list-item");
      for (const item of propItems) {
        const propTitle = item
          .querySelector(".unf-prop-list-title")
          ?.textContent.trim();
        if (propTitle === "Marka") {
          const propValue = item.querySelector(".unf-prop-list-prop");
          brand = propValue ? propValue.textContent.trim() : null;
          break;
        }
      }

      // Extract price and currency
      const priceElement = document.querySelector(".newPrice ins");
      let price = null;
      let currency = null;
      if (priceElement) {
        const priceText = priceElement.textContent.trim();
        const priceMatch = priceText.match(/(\d+,\d+)/);
        price = priceMatch ? parseFloat(priceMatch[0].replace(",", ".")) : null;
        const currencyElement = priceElement.querySelector("span");
        currency = currencyElement ? currencyElement.textContent.trim() : null;
      }

      // Extract images
      const imageElements = document.querySelectorAll(
        ".unf-p-thumbs .unf-p-thumbs-item img"
      );
      const imageUrls = Array.from(imageElements)
        .map((img) => img.getAttribute("src"))
        .filter((src) => src && src !== "");
      const images = imageUrls.length > 0 ? imageUrls.join(";") : null;

      // Extract rating (favorite count)
      const ratingElement = document.querySelector(
        ".favorite-button-content .wishListCount"
      );
      let rating = null;
      if (ratingElement) {
        const ratingText = ratingElement.textContent.trim();
        const ratingMatch = ratingText.match(/(\d+)/);
        rating = ratingMatch ? parseInt(ratingMatch[0], 10) : null;
      }

      return { title, brand, price, currency, images, rating };
    });

    console.log(
      `Extracted title: ${details.title}, brand: ${details.brand}, price: ${details.price}, currency: ${details.currency}, images: ${details.images}, rating: ${details.rating} from ${url}`
    );
    return {
      url,
      title: details.title,
      brand: details.brand,
      price: details.price,
      currency: details.currency,
      images: details.images,
      rating: details.rating,
    };
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
      error: error.message,
    };
  }
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

    // Array to hold all products across all URLs
    const allProducts = [];

    for (const baseUrl of urls) {
      console.log(`Starting process for: ${baseUrl}`);
      const mainPage = await browser.newPage();
      await mainPage.setViewport({ width: 1366, height: 768 });
      await mainPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      const productUrls = await scrollAndLoad(mainPage, baseUrl);
      await mainPage.close();

      // Process each product in a new tab
      for (const productUrl of productUrls) {
        const productPage = await browser.newPage();
        const absoluteUrl = productUrl.startsWith("http")
          ? productUrl
          : `${baseUrl.split("/").slice(0, 3).join("/")}${productUrl}`;
        const details = await scrapeProductDetails(productPage, absoluteUrl);
        allProducts.push(details);
        await productPage.close();
      }

      console.log(`Finished processing for: ${baseUrl}\n`);
      shouldStop = false;
    }

    // Save output as a flat array
    const outputFileName = path.join(outputDir, `products_${dateStr}.json`);
    fs.writeFileSync(outputFileName, JSON.stringify(allProducts, null, 2));

    await browser.close();
    console.log("All URLs processed successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Error during processing:", error);
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
