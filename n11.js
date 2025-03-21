const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const { default: axios } = require("axios");
const port = 33335;
const session_id = (1000000 * Math.random()) | 0;
const options = {
  auth: {
    username: `brd-customer-hl_7930d613-zone-davutbey-session-${session_id}`,
    password: "3wa371vuwi2e",
  },
  host: "brd.superproxy.io",
  port,
  rejectUnauthorized: false,
};
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
)}-${String(today.getDate()).padStart(2, "0")}`;

// Utility to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Launch browser with retry logic
const launchBrowser = async (retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (browser && browser.isConnected()) return browser;
      browser = await puppeteer.launch({
        headless: true, // Headless mode for server
        protocolTimeout: 86400000,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      });
      return browser;
    } catch (error) {
      console.error(`Browser launch attempt ${i + 1} failed:`, error);
      if (i === retries - 1) throw error;
      await delay(2000);
    }
  }
};

// Extract product URLs from a page using Cheerio
const extractProductUrls = (html, baseUrl) => {
  const $ = cheerio.load(html);
  const productElements = $(".columnContent");
  return productElements
    .map((i, element) => {
      const linkElement = $(element).find(".pro a[href]");
      const href = linkElement.attr("href");
      return href && !href.includes("javascript:") ? href : null;
    })
    .get()
    .filter(Boolean)
    .map((url) => (url.startsWith("http") ? url : new URL(url, baseUrl).href));
};

// Scrape products page by page
const scrapePageByPage = async (page, baseUrl, processedUrls = new Set()) => {
  console.log(`Starting scrape for: ${baseUrl}`);
  let allProductUrls = new Set();
  let currentPage = 1;
  let totalProducts = 0;

  while (!shouldStop) {
    const pageUrl = `${baseUrl.split("?")[0]}?pg=${currentPage}`;
    console.log(`Scraping page ${currentPage}: ${pageUrl}`);

    try {
      await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 60000 });
      await delay(5000); // Increased delay to avoid rate limiting

      const html = await page.content();
      const $ = cheerio.load(html);

      // Get total products if not already set
      if (currentPage === 1) {
        const resultText = $(".listOptionHolder .resultText strong").text();
        totalProducts = resultText
          ? parseInt(resultText.replace(/[^0-9-]/g, ""), 10) || 0
          : 0;
        console.log(`Total products expected: ${totalProducts}`);
      }

      const currentUrls = extractProductUrls(html, baseUrl);
      currentUrls.forEach((url) => {
        if (!processedUrls.has(url)) allProductUrls.add(url);
      });
      console.log(
        `Page ${currentPage}: Found ${currentUrls.length} URLs, Unique new: ${allProductUrls.size}`
      );

      if (
        totalProducts > 0 &&
        allProductUrls.size + processedUrls.size >= totalProducts
      ) {
        console.log(`Collected all ${totalProducts} products.`);
        break;
      }

      const hasNextPage = $(".pagination a.next:not(.disabled)").length > 0;
      if (!hasNextPage) {
        console.log(`No next page found after page ${currentPage}.`);
        break;
      }

      currentPage++;
    } catch (error) {
      console.error(`Error on page ${currentPage}:`, error.message);
      break;
    }
  }

  return { productUrls: Array.from(allProductUrls), totalProducts };
};

// Scrape individual product details with retries using Cheerio
const scrapeProductDetails = async (page, url, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, options);
      console.log(`Scraping product: ${url}`);
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await delay(3000);

      const html = await page.content();
      const $ = cheerio.load(response.data);

      const title = $(".unf-p-title .proName").text().trim() || null;
      let brand = null;
      $(".unf-prop-list-item").each((i, item) => {
        if ($(item).find(".unf-prop-list-title").text().trim() === "Marka") {
          brand = $(item).find(".unf-prop-list-prop").text().trim() || null;
        }
      });

      const priceElement = $(".newPrice ins");
      const price = priceElement.attr("content")
        ? parseFloat(priceElement.attr("content"))
        : null;
      const currency =
        priceElement.find("span").attr("content") ||
        priceElement.find("span").text().trim() ||
        null;

      const imageUrls = $(".unf-p-thumbs .unf-p-thumbs-item img")
        .map((i, img) => $(img).attr("src"))
        .get()
        .filter(Boolean);
      const images = imageUrls.length ? imageUrls.join(";") : null;

      const rating = $(".ratingCont .ratingScore").text().trim()
        ? parseFloat($(".ratingCont .ratingScore").text().trim())
        : null;
      const shippingFee = $(".shipping-fee, .delivery-cost")
        .text()
        .replace(/[^\d.]/g, "")
        ? parseFloat(
            $(".shipping-fee, .delivery-cost")
              .text()
              .replace(/[^\d.]/g, "")
          )
        : null;
      const description = $(".unf-info-desc").text().trim() || null;

      const specifications = $(".unf-prop-list-item")
        .map((i, item) => ({
          name: $(item).find(".unf-prop-list-title").text().trim(),
          value: $(item).find(".unf-prop-list-prop").text().trim(),
        }))
        .get()
        .filter((spec) => spec.name && spec.value);

      const categories =
        $(".breadcrumb, .breadcrumbs").text().trim().replace(/\s+/g, ">") ||
        null;
      const productId = url.match(/-(\d+)(?:[?/#]|$)/)?.[1] || null;

      return {
        url,
        title,
        brand,
        price,
        currency,
        images,
        rating,
        shipping_fee: shippingFee,
        description,
        specifications,
        categories,
        productId,
      };
    } catch (error) {
      console.error(`Attempt ${i + 1} failed for ${url}:`, error.message);
      if (i === retries - 1) {
        return {
          url,
          title: null,
          brand: null,
          price: null,
          currency: null,
          images: null,
          rating: null,
          shipping_fee: null,
          description: null,
          specifications: [],
          categories: null,
          productId: null,
          error: error.message,
        };
      }
      await delay(5000);
    }
  }
};

// Save products to file
const saveProductsToFile = (products, filePath) => {
  fs.writeFileSync(filePath, JSON.stringify(products, null, 2));
};

// Load existing products
const loadExistingProducts = (baseUrl, dir) => {
  const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
  const existingFiles = fs
    .readdirSync(dir)
    .filter((file) => file.includes(urlSlug) && file.endsWith(".json"));
  const existingProducts = new Set();

  for (const file of existingFiles) {
    try {
      const data = fs.readFileSync(path.join(dir, file), "utf8");
      const products = JSON.parse(data);
      products.forEach(
        (product) => product.url && existingProducts.add(product.url)
      );
    } catch (error) {
      console.error(`Error reading ${file}:`, error.message);
    }
  }
  console.log(
    `Loaded ${existingProducts.size} existing products for ${baseUrl}`
  );
  return existingProducts;
};

// Main scraping function
const scrapeMultipleUrls = async () => {
  const urls = process.argv.slice(2);
  if (!urls.length) {
    console.error("Usage: node script.js <url1> <url2> ...");
    process.exit(1);
  }

  try {
    await launchBrowser();
    const n11Dir = path.join(outputDir, "n11");
    if (!fs.existsSync(n11Dir)) fs.mkdirSync(n11Dir, { recursive: true });

    for (const baseUrl of urls) {
      console.log(`\nProcessing: ${baseUrl}`);
      const processedUrls = loadExistingProducts(baseUrl, n11Dir);
      const productsArray = [];

      const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .split("Z")[0];
      const outputFileName = path.join(
        n11Dir,
        `products_${dateStr}_${urlSlug}_${timestamp}.json`
      );
      saveProductsToFile(productsArray, outputFileName);

      const mainPage = await browser.newPage();
      await mainPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      const { productUrls, totalProducts } = await scrapePageByPage(
        mainPage,
        baseUrl,
        processedUrls
      );
      await mainPage.close();

      console.log(
        `Found ${productUrls.length} new product URLs out of ${totalProducts}`
      );

      for (let i = 0; i < productUrls.length; i++) {
        const productUrl = productUrls[i];
        if (processedUrls.has(productUrl)) {
          console.log(`Skipping processed URL: ${productUrl}`);
          continue;
        }

        const productPage = await browser.newPage();
        try {
          const details = await scrapeProductDetails(productPage, productUrl);
          productsArray.push(details);
          processedUrls.add(productUrl);
          saveProductsToFile(productsArray, outputFileName);
          console.log(
            `Progress: ${productsArray.length}/${totalProducts} - Saved ${productUrl}`
          );
        } catch (error) {
          console.error(`Failed to scrape ${productUrl}:`, error);
        } finally {
          await productPage.close();
        }
        await delay(2000); // Rate limiting
      }

      while (totalProducts > 0 && processedUrls.size < totalProducts - 1) {
        console.log(
          `Retrying: ${processedUrls.size}/${totalProducts} collected`
        );
        const retryPage = await browser.newPage();
        const { productUrls: newUrls } = await scrapePageByPage(
          retryPage,
          baseUrl,
          processedUrls
        );
        await retryPage.close();

        for (const productUrl of newUrls) {
          if (processedUrls.has(productUrl)) continue;
          const productPage = await browser.newPage();
          try {
            const details = await scrapeProductDetails(productPage, productUrl);
            productsArray.push(details);
            processedUrls.add(productUrl);
            saveProductsToFile(productsArray, outputFileName);
            console.log(
              `Retry Progress: ${productsArray.length}/${totalProducts}`
            );
          } finally {
            await productPage.close();
          }
          await delay(2000);
        }
      }

      console.log(
        `Completed ${baseUrl}: ${processedUrls.size}/${totalProducts} products saved to ${outputFileName}`
      );
    }

    await browser.close();
    console.log("All URLs processed.");
    process.exit(0);
  } catch (error) {
    console.error("Fatal error:", error);
    if (browser) await browser.close();
    process.exit(1);
  }
};

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  shouldStop = true;
  if (browser) await browser.close();
  process.exit(0);
});

scrapeMultipleUrls();
