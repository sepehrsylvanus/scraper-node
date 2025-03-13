const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const outputDir = path.join(__dirname, "output");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

let browser;
let shouldStop = false;
let isFirstProduct = true;

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
    return resultElement ? parseInt(resultElement.textContent.trim(), 10) : 0;
  });
  console.log(`Total products expected: ${totalProducts || "Unknown"}`);

  let allProductUrls = new Set();
  let currentPage = 1;

  while (!shouldStop) {
    console.log(`Scraping page ${currentPage}...`);
    const currentUrls = await extractProductUrls(page);
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

    // Check if there's a next page
    const hasNextPage = await page.evaluate(() => {
      const nextButton = document.querySelector(
        ".pagination a.next:not(.disabled)"
      ); // Adjust selector if needed
      return !!nextButton;
    });

    if (!hasNextPage) {
      console.log(`No next page available after page ${currentPage}.`);
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
      console.log(
        `Reached the end or failed to navigate to ${nextUrl}:`,
        error.message
      );
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

const initializeOutputFile = (outputFileName) => {
  fs.writeFileSync(outputFileName, "[\n");
};

const saveProductToFile = (product, outputFileName) => {
  const productJson = JSON.stringify(product, null, 2);
  const prefix = isFirstProduct ? "  " : ",\n  ";
  fs.appendFileSync(
    outputFileName,
    prefix + productJson.split("\n").join("\n  ")
  );
  if (isFirstProduct) isFirstProduct = false;
};

const finalizeOutputFile = (outputFileName) => {
  fs.appendFileSync(outputFileName, "\n]");
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

    const processedUrls = new Set();
    const allProductUrls = [];
    const n11Dir = path.join(outputDir, "n11");
    if (!fs.existsSync(n11Dir)) {
      fs.mkdirSync(n11Dir, { recursive: true });
    }

    const outputFileName = path.join(n11Dir, `products_${dateStr}.json`);
    initializeOutputFile(outputFileName);

    for (const baseUrl of urls) {
      console.log(`\nProcessing URL: ${baseUrl}`);
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
      console.log(`Initial scrape collected ${productUrls.length} products.`);

      // Process initial batch
      for (const productUrl of productUrls) {
        const productPage = await browser.newPage();
        try {
          const details = await scrapeProductDetails(productPage, productUrl);
          saveProductToFile(details, outputFileName);
          processedUrls.add(productUrl);
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

        // Process new URLs
        for (const productUrl of newUrls) {
          const productPage = await browser.newPage();
          try {
            const details = await scrapeProductDetails(productPage, productUrl);
            saveProductToFile(details, outputFileName);
            processedUrls.add(productUrl);
          } catch (error) {
            console.error(
              `Skipping product ${productUrl} due to error:`,
              error
            );
          } finally {
            await productPage.close();
          }
        }

        // Stop if no new products were found
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
    }

    finalizeOutputFile(outputFileName);
    await browser.close();
    console.log(
      `\nAll URLs processed successfully. Data saved to ${outputFileName}`
    );
    console.log(`Total products processed: ${processedUrls.size}`);
    process.exit(0);
  } catch (error) {
    console.error("Error during processing:", error);
    if (browser) await browser.close();
    const outputFileName = path.join(
      outputDir,
      "n11",
      `products_${dateStr}.json`
    );
    finalizeOutputFile(outputFileName);
    process.exit(1);
  }
};

process.on("SIGINT", async () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  shouldStop = true;
  if (browser) await browser.close();
  const outputFileName = path.join(
    outputDir,
    "n11",
    `products_${dateStr}.json`
  );
  finalizeOutputFile(outputFileName);
  process.exit(0);
});

scrapeMultipleUrls();
