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
  console.log(`Starting process for: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  await delay(3000);

  const totalProducts = await page.evaluate(() => {
    const resultElement = document.querySelector(
      ".listOptionHolder .resultText strong"
    );
    return resultElement ? parseInt(resultElement.textContent.trim(), 10) : 0;
  });
  console.log(`Total products expected: ${totalProducts || "Unknown"}`);

  let allProductUrls = new Set();
  let currentPage = 1;
  let lastPage = null;

  while (!shouldStop) {
    let scrollPosition = 0;
    console.log(`Processing page ${currentPage}...`);
    let fWrapperVisible = false;

    while (!shouldStop && !fWrapperVisible) {
      await page.evaluate((pos) => {
        window.scrollTo(0, pos);
      }, scrollPosition);
      scrollPosition += 500;
      await delay(2000);

      const currentUrls = await extractProductUrls(page);
      currentUrls.forEach((url) => allProductUrls.add(url));
      console.log(
        `Loaded ${allProductUrls.size}/${
          totalProducts || "unknown"
        } products at scroll position: ${scrollPosition}`
      );

      fWrapperVisible = await page.evaluate(() => {
        const fWrapper = document.querySelector(".fWrapper");
        if (!fWrapper) return false;
        const rect = fWrapper.getBoundingClientRect();
        return rect.top >= 0 && rect.top <= window.innerHeight;
      });

      if (fWrapperVisible) {
        console.log(`Reached fWrapper on page ${currentPage}.`);
      }
    }

    const paginationInfo = await page.evaluate(() => {
      const activePage = document.querySelector(".pagination .active");
      const pages = Array.from(
        document.querySelectorAll(".pagination a[data-page]")
      );
      const current = activePage
        ? parseInt(activePage.getAttribute("data-page"), 10)
        : 1;
      const last =
        pages.length > 0
          ? Math.max(
              ...pages.map((p) => parseInt(p.getAttribute("data-page"), 10))
            )
          : current;
      return { current, last };
    });

    currentPage = paginationInfo.current;
    if (!lastPage) lastPage = paginationInfo.last;
    console.log(`Current page: ${currentPage}, Last page: ${lastPage}`);

    if (totalProducts > 0 && allProductUrls.size >= totalProducts) {
      console.log(`All ${totalProducts} products loaded.`);
      break;
    }
    if (currentPage >= lastPage) {
      console.log(`Reached the last page (${lastPage}).`);
      break;
    }

    const nextPage = currentPage + 1;
    const nextUrl = `${baseUrl.split("?")[0]}?pg=${nextPage}`;
    console.log(`Navigating to next page: ${nextUrl}`);
    try {
      await page.goto(nextUrl, { waitUntil: "networkidle2" });
      await delay(3000);
      currentPage = nextPage;
    } catch (error) {
      console.error(`Failed to navigate to ${nextUrl}:`, error);
      break;
    }
  }

  const productUrls = Array.from(allProductUrls);
  console.log(`Collected ${productUrls.length} unique product URLs.`);

  return productUrls;
};

const scrapeProductDetails = async (page, url) => {
  try {
    console.log(`Opening product page: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2" });
    await delay(2000);

    const details = await page.evaluate(() => {
      const titleElement = document.querySelector(".unf-p-title .proName");
      const title = titleElement ? titleElement.textContent.trim() : null;

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

      const priceElement = document.querySelector(".newPrice ins");
      let price = null;
      let currency = null;
      if (priceElement) {
        price = priceElement.getAttribute("content")
          ? parseFloat(priceElement.getAttribute("content"))
          : null;
        const currencyElement = priceElement.querySelector("span");
        currency = currencyElement
          ? currencyElement.getAttribute("content") ||
            currencyElement.textContent.trim()
          : null;
      }

      const imageElements = document.querySelectorAll(
        ".unf-p-thumbs .unf-p-thumbs-item img"
      );
      const imageUrls = Array.from(imageElements)
        .map((img) => img.getAttribute("src"))
        .filter((src) => src && src !== "");
      const images = imageUrls.length > 0 ? imageUrls.join(";") : null;

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

    const allProducts = [];
    const allProductUrls = [];

    // Create n11 directory inside output
    const n11Dir = path.join(outputDir, "n11");
    if (!fs.existsSync(n11Dir)) {
      fs.mkdirSync(n11Dir, { recursive: true });
    }

    // Step 1: Collect all product URLs
    for (const baseUrl of urls) {
      console.log(`Collecting URLs for: ${baseUrl}`);
      const mainPage = await browser.newPage();
      await mainPage.setViewport({ width: 1366, height: 768 });
      await mainPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      const productUrls = await scrollAndLoad(mainPage, baseUrl);
      productUrls.forEach((url) => {
        const absoluteUrl = url.startsWith("http")
          ? url
          : `${baseUrl.split("/").slice(0, 3).join("/")}${url}`;
        allProductUrls.push(absoluteUrl);
      });
      await mainPage.close();
      console.log(`Finished collecting URLs for: ${baseUrl}\n`);
    }

    console.log(`Total unique URLs collected: ${allProductUrls.length}`);

    // Step 2: Process all product URLs
    for (const productUrl of allProductUrls) {
      const productPage = await browser.newPage();
      const details = await scrapeProductDetails(productPage, productUrl);
      allProducts.push(details);
      await productPage.close();
    }

    // Save to n11 folder
    const outputFileName = path.join(n11Dir, `products_${dateStr}.json`);
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
