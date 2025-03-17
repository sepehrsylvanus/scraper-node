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
        const linkElement = element.querySelector(".pro a[href]");
        return linkElement ? linkElement.getAttribute("href") : null;
      })
      .filter((url) => url !== null);
  });
};

const scrapePageByPage = async (page, baseUrl, processedUrls = new Set()) => {
  console.log(`Starting page-by-page scrape for: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  await delay(3000);

  const totalProducts = await page.evaluate(() => {
    const resultElement = document.querySelector(
      ".listOptionHolder .resultText strong"
    );
    if (!resultElement) return 0;
    const text = resultElement.textContent.trim();
    const cleanedNumber = text.replace(/[^0-9-]/g, "");
    return cleanedNumber ? parseInt(cleanedNumber, 10) : 0;
  });
  console.log(`Total products expected: ${totalProducts || "Unknown"}`);

  let allProductUrls = new Set();
  let currentPage = 1;
  const maxRetriesPerPage = 3; // Maximum retries per page if products are missing

  while (
    !shouldStop &&
    (totalProducts === 0 ||
      allProductUrls.size + processedUrls.size < totalProducts)
  ) {
    console.log(`Scraping page ${currentPage}...`);
    let retries = 0;
    let currentUrls = [];

    // Retry logic for each page
    while (retries < maxRetriesPerPage) {
      try {
        currentUrls = await extractProductUrls(page);
        const expectedPerPage = Math.min(
          28,
          totalProducts - allProductUrls.size - processedUrls.size
        ); // Assuming ~28 products per page
        if (currentUrls.length >= expectedPerPage || currentUrls.length === 0) {
          console.log(
            `Found ${currentUrls.length} products on page ${currentPage}, proceeding...`
          );
          break; // Exit retry loop if enough products are found or no products are found
        }
        console.log(
          `Only ${
            currentUrls.length
          }/${expectedPerPage} products found on page ${currentPage}. Retrying (${
            retries + 1
          }/${maxRetriesPerPage})...`
        );
        retries++;
        await page.reload({ waitUntil: "networkidle2" });
        await delay(5000); // Longer delay after refresh to ensure content loads
      } catch (error) {
        console.error(
          `Error extracting URLs on page ${currentPage}, retry ${retries + 1}:`,
          error.message
        );
        retries++;
        if (retries === maxRetriesPerPage) {
          console.log(
            `Max retries reached for page ${currentPage}. Moving forward with collected URLs.`
          );
          break;
        }
        await delay(5000);
      }
    }

    currentUrls.forEach((url) => {
      const absoluteUrl = url.startsWith("http")
        ? url
        : `${baseUrl.split("/").slice(0, 3).join("/")}${url}`;
      if (!processedUrls.has(absoluteUrl)) {
        allProductUrls.add(absoluteUrl);
      }
    });
    console.log(
      `Collected ${allProductUrls.size}/${
        totalProducts || "unknown"
      } unique products on page ${currentPage}`
    );

    if (
      totalProducts > 0 &&
      allProductUrls.size + processedUrls.size >= totalProducts
    ) {
      console.log(`All ${totalProducts} products accounted for in this pass.`);
      break;
    }

    const hasNextPage = await page.evaluate(() => {
      const nextButton = document.querySelector(
        ".pagination a.next:not(.disabled)"
      );
      return !!nextButton;
    });

    if (!hasNextPage) {
      console.log(`No next page available after page ${currentPage}.`);
      if (
        totalProducts > 0 &&
        allProductUrls.size + processedUrls.size < totalProducts
      ) {
        console.log(
          `Missing products (${
            allProductUrls.size + processedUrls.size
          }/${totalProducts}). Restarting from page 1...`
        );
        currentPage = 1; // Restart from the beginning if products are missing
        await page.goto(baseUrl, { waitUntil: "networkidle2" });
        await delay(3000);
        continue;
      }
      break;
    }

    const nextPage = currentPage + 1;
    const nextUrl = `${baseUrl.split("?")[0]}?pg=${nextPage}`;
    console.log(`Navigating to next page: ${nextUrl}`);
    try {
      await page.goto(nextUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await delay(3000);
      currentPage = nextPage;
    } catch (error) {
      console.log(`Failed to navigate to ${nextUrl}:`, error.message);
      if (
        totalProducts > 0 &&
        allProductUrls.size + processedUrls.size < totalProducts
      ) {
        console.log(`Missing products. Restarting from page 1...`);
        currentPage = 1;
        await page.goto(baseUrl, { waitUntil: "networkidle2" });
        await delay(3000);
        continue;
      }
      break;
    }
  }

  const productUrls = Array.from(allProductUrls);
  console.log(
    `Collected ${productUrls.length} new unique product URLs in this pass.`
  );
  return { productUrls, totalProducts };
};

const scrapeProductDetails = async (page, url) => {
  try {
    console.log(`Opening product page: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await delay(2000);

    const details = await page.evaluate((pageUrl) => {
      try {
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
          ".ratingCont .ratingScore"
        );
        let rating = null;
        if (ratingElement) {
          const ratingText = ratingElement.textContent.trim();
          rating = ratingText ? parseFloat(ratingText) : null;
        }

        const shippingFeeElement =
          document.querySelector(".shipping-fee") ||
          document.querySelector(".delivery-cost");
        const shippingFee = shippingFeeElement
          ? parseFloat(shippingFeeElement.textContent.replace(/[^\d.]/g, ""))
          : null;

        const descriptionElement = document.querySelector(".unf-info-desc");
        const description = descriptionElement
          ? descriptionElement.textContent.trim()
          : null;

        const specItems = document.querySelectorAll(".unf-prop-list-item");
        const specifications = Array.from(specItems)
          .map((item) => {
            const name = item
              .querySelector(".unf-prop-list-title")
              ?.textContent.trim();
            const value = item
              .querySelector(".unf-prop-list-prop")
              ?.textContent.trim();
            return name && value ? { name, value } : null;
          })
          .filter((spec) => spec !== null);

        const categoriesElement =
          document.querySelector(".breadcrumb") ||
          document.querySelector(".breadcrumbs");
        const categories = categoriesElement
          ? categoriesElement.textContent.trim().replace(/\s+/g, ">")
          : null;

        const productIdMatch = pageUrl.match(/-(\d+)(?:[?/#]|$)/);
        const productId = productIdMatch ? productIdMatch[1] : null;

        return {
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
      } catch (evalError) {
        console.error(`Evaluation error on ${pageUrl}:`, evalError);
        throw evalError;
      }
    }, url);

    console.log(`Extracted details from ${url}:`, details);
    return {
      url,
      title: details.title,
      brand: details.brand,
      price: details.price,
      currency: details.currency,
      images: details.images,
      rating: details.rating,
      shipping_fee: details.shipping_fee,
      description: details.description,
      specifications: details.specifications,
      categories: details.categories,
      productId: details.productId,
    };
  } catch (error) {
    console.error(`Error scraping product at ${url}:`, error.message);
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
};

// Function to save the entire array to the file
const saveProductsToFile = (products, outputFileName) => {
  fs.writeFileSync(outputFileName, JSON.stringify(products, null, 2));
};

// Function to load existing products from files related to a base URL
const loadExistingProducts = (baseUrl, dir) => {
  const urlSlug = baseUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 50);
  const existingFiles = fs
    .readdirSync(dir)
    .filter((file) => file.includes(urlSlug) && file.endsWith(".json"));

  const existingProducts = new Set();
  for (const file of existingFiles) {
    try {
      const filePath = path.join(dir, file);
      const data = fs.readFileSync(filePath, "utf8");
      const products = JSON.parse(data);
      products.forEach((product) => {
        if (product.url) existingProducts.add(product.url);
      });
    } catch (error) {
      console.error(`Error reading file ${file}:`, error.message);
    }
  }
  console.log(
    `Loaded ${existingProducts.size} existing products for ${baseUrl}`
  );
  return existingProducts;
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

    const n11Dir = path.join(outputDir, "n11");
    if (!fs.existsSync(n11Dir)) {
      fs.mkdirSync(n11Dir, { recursive: true });
    }

    for (const baseUrl of urls) {
      console.log(`\nProcessing URL: ${baseUrl}`);
      const processedUrls = loadExistingProducts(baseUrl, n11Dir); // Load existing products
      const allProductUrls = [];
      const productsArray = [];

      // Generate unique filename with timestamp
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

      // Initialize the file with an empty array
      saveProductsToFile(productsArray, outputFileName);

      let totalProducts = 0;

      // Initial scrape
      let mainPage = await browser.newPage();
      await mainPage.setViewport({ width: 1366, height: 768 });
      await mainPage.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      let { productUrls, totalProducts: initialTotal } = await scrapePageByPage(
        mainPage,
        baseUrl,
        processedUrls
      );
      totalProducts = initialTotal;
      productUrls.forEach((url) => allProductUrls.push(url));
      await mainPage.close();
      console.log(
        `Initial scrape collected ${productUrls.length} new products.`
      );

      // Process initial batch
      for (const productUrl of productUrls) {
        if (processedUrls.has(productUrl)) {
          console.log(`Skipping already processed product: ${productUrl}`);
          continue;
        }
        const productPage = await browser.newPage();
        try {
          const details = await scrapeProductDetails(productPage, productUrl);
          productsArray.push(details);
          processedUrls.add(productUrl);
          saveProductsToFile(productsArray, outputFileName);
          console.log(
            `Saved ${productsArray.length}/${totalProducts} products to ${outputFileName}`
          );
        } catch (error) {
          console.error(`Skipping product ${productUrl} due to error:`, error);
        } finally {
          await productPage.close();
        }
      }

      // Retry until all products are collected or no new products are found
      while (totalProducts > 0 && processedUrls.size < totalProducts) {
        console.log(
          `Only ${processedUrls.size}/${totalProducts} products collected. Retrying from first page...`
        );
        const retryPage = await browser.newPage();
        await retryPage.setViewport({ width: 1366, height: 768 });
        await retryPage.setUserAgent(
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
        );

        const previousSize = processedUrls.size;
        const { productUrls: newUrls } = await scrapePageByPage(
          retryPage,
          baseUrl,
          processedUrls
        );
        newUrls.forEach((url) => allProductUrls.push(url));
        await retryPage.close();
        console.log(`Retry collected ${newUrls.length} new product URLs.`);

        for (const productUrl of newUrls) {
          if (processedUrls.has(productUrl)) {
            console.log(`Skipping already processed product: ${productUrl}`);
            continue;
          }
          const productPage = await browser.newPage();
          try {
            const details = await scrapeProductDetails(productPage, productUrl);
            productsArray.push(details);
            processedUrls.add(productUrl);
            saveProductsToFile(productsArray, outputFileName);
            console.log(
              `Saved ${productsArray.length}/${totalProducts} products to ${outputFileName}`
            );
          } catch (error) {
            console.error(
              `Skipping product ${productUrl} due to error:`,
              error
            );
          } finally {
            await productPage.close();
          }
        }

        if (processedUrls.size === previousSize) {
          console.log(
            `No new products found in retry. Stopping further attempts.`
          );
          break;
        }
      }

      console.log(
        `Finished processing ${baseUrl}. Total collected: ${processedUrls.size}/${totalProducts}`
      );
      console.log(`Final data saved to ${outputFileName}`);
    }

    await browser.close();
    console.log("\nAll URLs processed successfully.");
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
