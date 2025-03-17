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

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36",
];

const launchBrowser = async () => {
  try {
    if (browser && browser.isConnected()) return browser;
    return await puppeteer.launch({
      headless: true,
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

const scrapeProducts = async (page, baseUrl, processedUrls = new Set()) => {
  console.log(`Starting scrape for: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  await delay(3000 + Math.random() * 2000);

  const totalProductsEstimate = await page.evaluate(() => {
    const resultElement = document.querySelector(
      ".listOptionHolder .resultText strong"
    );
    const text = resultElement ? resultElement.textContent.trim() : "0";
    console.log(`Raw total products text: ${text}`);
    const cleanedNumber = text.replace(/[^0-9-]/g, "");
    return cleanedNumber ? parseInt(cleanedNumber, 10) : 0;
  });
  console.log(
    `Estimated total products: ${totalProductsEstimate || "Unknown"}`
  );

  let allProductUrls = new Set();
  let currentPage = 1;
  const maxRetriesPerPage = 5;
  const maxGlobalRetries = 10;
  let globalRetryCount = 0;

  // Try pagination first
  while (!shouldStop) {
    console.log(
      `Scraping page ${currentPage} (Global retry ${
        globalRetryCount + 1
      }/${maxGlobalRetries})`
    );
    let retries = 0;
    let currentUrls = [];

    while (retries < maxRetriesPerPage) {
      try {
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight)
        );
        await delay(2000 + Math.random() * 1000);
        currentUrls = await extractProductUrls(page);
        console.log(
          `Found ${currentUrls.length} products on page ${currentPage}`
        );
        break;
      } catch (error) {
        console.error(
          `Error on page ${currentPage}, retry ${retries + 1}:`,
          error.message
        );
        retries++;
        if (retries === maxRetriesPerPage) {
          console.log(
            `Max retries reached for page ${currentPage}. Moving on.`
          );
          break;
        }
        await page.reload({ waitUntil: "networkidle2" });
        await delay(5000 * (retries + 1));
      }
    }

    currentUrls.forEach((url) => {
      const absoluteUrl = url.startsWith("http")
        ? url
        : `${baseUrl.split("/").slice(0, 3).join("/")}${url}`;
      if (!processedUrls.has(absoluteUrl)) {
        allProductUrls.add(absoluteUrl);
        console.log(`Added URL: ${absoluteUrl}`);
      }
    });
    console.log(`Collected ${allProductUrls.size} unique products so far`);

    const hasNextPage = await page.evaluate(
      () => !!document.querySelector(".pagination a.next:not(.disabled)")
    );
    if (
      !hasNextPage ||
      (totalProductsEstimate > 0 &&
        allProductUrls.size >= totalProductsEstimate)
    ) {
      console.log(
        `No next page or all ${totalProductsEstimate} products collected. Checking for infinite scroll...`
      );
      break;
    }

    currentPage++;
    const nextUrl = `${baseUrl.split("?")[0]}?pg=${currentPage}`;
    try {
      await page.goto(nextUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await delay(3000 + Math.random() * 2000);
    } catch (error) {
      console.error(`Failed to navigate to ${nextUrl}:`, error.message);
      if (globalRetryCount < maxGlobalRetries) {
        globalRetryCount++;
        currentPage = 1;
        await page.goto(baseUrl, { waitUntil: "networkidle2" });
        await delay(5000 * (globalRetryCount + 1));
      } else {
        break;
      }
    }
  }

  // Fallback to infinite scrolling if pagination didn’t get all products
  if (
    totalProductsEstimate > allProductUrls.size ||
    allProductUrls.size < 8000
  ) {
    console.log("Switching to infinite scroll mode...");
    await page.goto(baseUrl, { waitUntil: "networkidle2" });
    let previousHeight = 0;
    while (!shouldStop) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(3000 + Math.random() * 2000);
      const currentUrls = await extractProductUrls(page);
      currentUrls.forEach((url) => {
        const absoluteUrl = url.startsWith("http")
          ? url
          : `${baseUrl.split("/").slice(0, 3).join("/")}${url}`;
        if (!processedUrls.has(absoluteUrl)) allProductUrls.add(absoluteUrl);
      });

      const currentHeight = await page.evaluate(
        () => document.body.scrollHeight
      );
      if (currentHeight === previousHeight) {
        console.log("No new content loaded. Stopping scroll.");
        break;
      }
      previousHeight = currentHeight;
      console.log(`Infinite scroll collected ${allProductUrls.size} products`);
    }
  }

  const productUrls = Array.from(allProductUrls);
  console.log(`Total unique product URLs collected: ${productUrls.length}`);
  return { productUrls, totalProducts: totalProductsEstimate };
};

const scrapeProductDetails = async (page, url) => {
  try {
    console.log(`Scraping product page: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    await delay(2000 + Math.random() * 1000);

    const details = await page.evaluate((pageUrl) => {
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
      let price = priceElement?.getAttribute("content")
        ? parseFloat(priceElement.getAttribute("content"))
        : null;
      const currency =
        priceElement?.querySelector("span")?.getAttribute("content") ||
        priceElement?.querySelector("span")?.textContent.trim() ||
        null;

      const imageElements = document.querySelectorAll(
        ".unf-p-thumbs .unf-p-thumbs-item img"
      );
      const images =
        Array.from(imageElements)
          .map((img) => img.getAttribute("src"))
          .filter((src) => src)
          .join(";") || null;

      const rating = document
        .querySelector(".ratingCont .ratingScore")
        ?.textContent.trim()
        ? parseFloat(
            document
              .querySelector(".ratingCont .ratingScore")
              .textContent.trim()
          )
        : null;

      const shippingFee = document
        .querySelector(".shipping-fee, .delivery-cost")
        ?.textContent.replace(/[^\d.]/g, "")
        ? parseFloat(
            document
              .querySelector(".shipping-fee, .delivery-cost")
              .textContent.replace(/[^\d.]/g, "")
          )
        : null;

      const description =
        document.querySelector(".unf-info-desc")?.textContent.trim() || null;

      const specifications = Array.from(
        document.querySelectorAll(".unf-prop-list-item")
      )
        .map((item) => {
          const name = item
            .querySelector(".unf-prop-list-title")
            ?.textContent.trim();
          const value = item
            .querySelector(".unf-prop-list-prop")
            ?.textContent.trim();
          return name && value ? { name, value } : null;
        })
        .filter((spec) => spec);

      const categories =
        document
          .querySelector(".breadcrumb, .breadcrumbs")
          ?.textContent.trim()
          .replace(/\s+/g, ">") || null;

      const productId = pageUrl.match(/-(\d+)(?:[?/#]|$)/)?.[1] || null;

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
    }, url);

    return { url, ...details };
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

const saveProductsToFile = (products, outputFileName) => {
  fs.writeFileSync(outputFileName, JSON.stringify(products, null, 2));
};

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
  if (!urls.length) {
    console.error("No URLs provided. Usage: node script.js <url1> <url2> ...");
    process.exit(1);
  }

  try {
    browser = await launchBrowser();
    const n11Dir = path.join(outputDir, "n11");
    if (!fs.existsSync(n11Dir)) fs.mkdirSync(n11Dir, { recursive: true });

    for (const baseUrl of urls) {
      console.log(`\nProcessing URL: ${baseUrl}`);
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
      await mainPage.setViewport({ width: 1366, height: 768 });
      await mainPage.setUserAgent(
        userAgents[Math.floor(Math.random() * userAgents.length)]
      );

      const { productUrls, totalProducts } = await scrapeProducts(
        mainPage,
        baseUrl,
        processedUrls
      );
      await mainPage.close();

      const chunkSize = 3;
      for (let i = 0; i < productUrls.length; i += chunkSize) {
        const chunk = productUrls.slice(i, i + chunkSize);
        await Promise.all(
          chunk.map(async (productUrl) => {
            if (processedUrls.has(productUrl)) {
              console.log(`Skipping already processed: ${productUrl}`);
              return;
            }
            const productPage = await browser.newPage();
            await productPage.setUserAgent(
              userAgents[Math.floor(Math.random() * userAgents.length)]
            );
            try {
              const details = await scrapeProductDetails(
                productPage,
                productUrl
              );
              productsArray.push(details);
              processedUrls.add(productUrl);
              saveProductsToFile(productsArray, outputFileName);
              console.log(
                `Saved ${productsArray.length}/${
                  totalProducts || "unknown"
                } products`
              );
            } catch (error) {
              console.error(`Error processing ${productUrl}:`, error);
            } finally {
              await productPage.close();
            }
          })
        );
      }

      // Retry missing products if totalProducts is known and not reached
      while (totalProducts > 0 && processedUrls.size < totalProducts) {
        console.log(
          `Retrying: ${processedUrls.size}/${totalProducts} collected`
        );
        const retryPage = await browser.newPage();
        await retryPage.setViewport({ width: 1366, height: 768 });
        await retryPage.setUserAgent(
          userAgents[Math.floor(Math.random() * userAgents.length)]
        );

        const previousSize = processedUrls.size;
        const { productUrls: newUrls } = await scrapeProducts(
          retryPage,
          baseUrl,
          processedUrls
        );
        await retryPage.close();

        for (let i = 0; i < newUrls.length; i += chunkSize) {
          const chunk = newUrls.slice(i, i + chunkSize);
          await Promise.all(
            chunk.map(async (productUrl) => {
              if (processedUrls.has(productUrl)) return;
              const productPage = await browser.newPage();
              await productPage.setUserAgent(
                userAgents[Math.floor(Math.random() * userAgents.length)]
              );
              try {
                const details = await scrapeProductDetails(
                  productPage,
                  productUrl
                );
                productsArray.push(details);
                processedUrls.add(productUrl);
                saveProductsToFile(productsArray, outputFileName);
              } catch (error) {
                console.error(`Error retrying ${productUrl}:`, error);
              } finally {
                await productPage.close();
              }
            })
          );
        }

        if (processedUrls.size === previousSize) {
          console.log("No new products found in retry. Stopping.");
          break;
        }
      }

      console.log(
        `Finished ${baseUrl}. Collected: ${processedUrls.size}/${
          totalProducts || "unknown"
        }`
      );
      console.log(`Data saved to ${outputFileName}`);
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
  console.log("Received SIGINT. Shutting down...");
  shouldStop = true;
  if (browser) await browser.close();
  process.exit(0);
});

scrapeMultipleUrls();
