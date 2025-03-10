const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const outputDir = path.join(__dirname, "output");

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

let browser;
let shouldStop = false;

readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

process.stdin.on("data", (key) => {
  if (key.toString().trim().toLowerCase() === "q") {
    console.log("\n[INFO] Received quit signal. Stopping scraping...");
    shouldStop = true;
  }
});

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const launchBrowser = async () => {
  try {
    if (browser) {
      console.log("[INFO] Using existing browser instance...");
      return browser;
    }
    console.log("[INFO] Launching new browser...");
    browser = await puppeteer.launch({
      headless: false,
      protocolTimeout: 86400000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
      ],
    });
    return browser;
  } catch (error) {
    console.error("[ERROR] Error launching browser:", error.message);
    throw error;
  }
};

const evaluateWithRetry = async (page, fn, retries = 3, delayMs = 2000) => {
  while (retries > 0) {
    try {
      return await page.evaluate(fn);
    } catch (error) {
      console.error(
        "[ERROR] Evaluation failed, retries left:",
        retries,
        error.message
      );
      retries--;
      await delay(delayMs);
    }
  }
  throw new Error("Max retries reached for evaluation");
};

const scrollToLoadAllProducts = async (page, totalProducts) => {
  console.log("[DEBUG] Entering scrollToLoadAllProducts...");
  let lastProductCount = 0;

  try {
    lastProductCount = await evaluateWithRetry(
      page,
      () => document.querySelectorAll(".listProductItem").length
    );
    console.log(
      `[INFO] Initial product count: ${lastProductCount}/${totalProducts}`
    );
  } catch (error) {
    console.error(
      "[ERROR] Failed to get initial product count:",
      error.message
    );
    lastProductCount = 0;
  }

  while (lastProductCount < totalProducts && !shouldStop) {
    const previousHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(3000); // Wait for new content to load

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    let currentProductCount = 0;

    try {
      currentProductCount = await evaluateWithRetry(
        page,
        () => document.querySelectorAll(".listProductItem").length
      );
      console.log(
        `[INFO] Current product count: ${currentProductCount}/${totalProducts}`
      );
    } catch (error) {
      console.error("[ERROR] Failed to get product count:", error.message);
      continue;
    }

    if (currentProductCount > lastProductCount) {
      console.log(
        `[INFO] New products loaded: ${currentProductCount}/${totalProducts}`
      );
      lastProductCount = currentProductCount;
    } else if (newHeight === previousHeight) {
      console.log(
        "[INFO] No new content loaded (reached end or limit), checking pagination..."
      );
      const hasPagination = await page.evaluate(() =>
        !!document.querySelector(".pagination")
      );
      if (hasPagination) {
        console.log("[INFO] Pagination detected, switching to pagination mode...");
        return await handlePagination(page, totalProducts);
      }
      break; // No new products and no pagination, assume we've loaded all
    }

    if (currentProductCount >= totalProducts) {
      console.log(
        `[INFO] Reached target: ${currentProductCount}/${totalProducts}`
      );
      break;
    }

    await delay(2000); // Additional wait between scrolls
  }

  return lastProductCount >= totalProducts;
};

const handlePagination = async (page, totalProducts) => {
  let allProductsLoaded = 0;
  let pageNumber = 1;

  while (allProductsLoaded < totalProducts && !shouldStop) {
    console.log(`[INFO] Processing page ${pageNumber}...`);

    try {
      const currentProductCount = await evaluateWithRetry(
        page,
        () => document.querySelectorAll(".listProductItem").length
      );
      console.log(
        `[INFO] Products on page ${pageNumber}: ${currentProductCount}/${totalProducts}`
      );
      allProductsLoaded = currentProductCount; // Note: This assumes each page replaces the previous content
    } catch (error) {
      console.error("[ERROR] Failed to count products:", error.message);
      break;
    }

    const nextPageButton = await page.$(".pagination .next");
    if (!nextPageButton) {
      console.log("[INFO] No more pages to process.");
      break;
    }

    try {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle0", timeout: 120000 }),
        nextPageButton.click(),
      ]);
      pageNumber++;
      await delay(3000);
    } catch (error) {
      console.error("[ERROR] Failed to navigate to next page:", error.message);
      break;
    }
  }

  return allProductsLoaded >= totalProducts;
};

const scrapeProductsFromUrl = async (url) => {
  let page;
  try {
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.setDefaultNavigationTimeout(120000);

    console.log(`[INFO] Navigating to ${url}`);
    await page.goto(url, {
      waitUntil: ["networkidle0", "domcontentloaded"],
      timeout: 120000,
    });
    console.log("[INFO] Page loaded successfully");

    let totalProducts = 0;
    try {
      totalProducts = await evaluateWithRetry(page, () => {
        const totalElement = document.querySelector(".product-list_total__TvMCW");
        return totalElement
          ? parseInt(totalElement.textContent.match(/\d+/)[0])
          : 0;
      });
      console.log(`[INFO] Total products expected: ${totalProducts}`);
    } catch (error) {
      console.error("[ERROR] Failed to get total products:", error.message);
      await page.close();
      return [];
    }

    await scrollToLoadAllProducts(page, totalProducts);
    console.log("[INFO] Scroll complete, waiting 5 seconds...");
    await delay(5000);

    let products = [];
    let scrapedProductUrls = new Set();

    const sanitizedFilename = url
      .replace(/https?:\/\//, "")
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase();
    const outputFilePath = path.join(outputDir, `${sanitizedFilename}_products.json`);

    // Extract all product URLs from the loaded page
    const productUrls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll(".listProductItem")).map(
        (element) =>
          "https://www.boyner.com.tr" +
          element.querySelector(".product-item_image__IxD4T a")?.getAttribute("href")
      );
    });
    console.log(`[INFO] Total product URLs found: ${productUrls.length}`);

    for (const productUrl of productUrls) {
      if (shouldStop || scrapedProductUrls.has(productUrl)) continue;

      let productPage;
      try {
        console.log(`[INFO] Opening product page: ${productUrl}`);
        productPage = await browser.newPage();
        await productPage.goto(productUrl, {
          waitUntil: "networkidle2",
          timeout: 120000,
        });

        const productContent = await productPage.content();
        const $$ = cheerio.load(productContent);

        const title = $$(".product-item_name__HVuFo").text().trim() || 
                      $$(".product-detail_name__3sAhd").text().trim(); // Fallback for product page
        const brand = $$(".product-item_brand__LFImW").text().trim() || 
                      $$(".product-detail_brand__2b9R6").text().trim(); // Fallback
        const priceText = $$(".product-price_checkPrice__NMY9e strong").text().trim() || 
                         $$(".product-price_price__6jV0N").text().trim(); // Fallback
        const price = parseFloat(priceText.match(/(\d+(\.\d+)?)/)?.[0] || "0");
        const currency = priceText.match(/[^\d\s]+/)?.[0] || "";
        const image1 = $$(
          '.product-image-layout_imageBig__8TB1z.product-image-layout_lbEnabled__IfV9T span img[data-nimg="intrinsic"]'
        ).attr("src");

        await productPage.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
        await delay(3000);

        const otherImages = await evaluateWithRetry(productPage, () => {
          const spans = document.querySelectorAll(
            ".product-image-layout_otherImages__KwpFh span"
          );
          return Array.from(spans)
            .map((span) => {
              const img = span.querySelector('img[data-nimg="intrinsic"]');
              return img && !img.src.startsWith("data:image") ? img.src : null;
            })
            .filter(
              (src) =>
                src &&
                src !==
                  document.querySelector(
                    '.product-image-layout_imageBig__8TB1z img[data-nimg="intrinsic"]'
                  )?.src
            );
        });

        const rating = await evaluateWithRetry(productPage, async () => {
          const ratingModal = document.querySelector(".rating-custom_reviewText__EUE7E");
          if (ratingModal) {
            ratingModal.click();
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const score = document.querySelector(".score-summary_score__VrQrb");
            const rating = score ? parseFloat(score.textContent) : "No rating";
            document.querySelector(".icon-close")?.click();
            return rating;
          }
          return "No rating";
        });

        const shipping_fee = await evaluateWithRetry(productPage, async () => {
          const target = Array.from(
            document.querySelectorAll(".tabs_title__gO9Hr")
          ).find((el) => el.textContent.includes("Teslimat Bilgileri"));
          if (target) {
            target.click();
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const fee = document.querySelector(
              ".delivery-information_wrapper__Ek_Uy div span strong"
            );
            const shippingFee = fee
              ? parseFloat(fee.textContent.match(/[\d,]+(\.[\d]+)?/)?.[0])
              : "No shipping fee";
            document.querySelector(".tab-modal_closeIcon__gUYKw")?.click();
            return shippingFee;
          }
          return "No shipping fee";
        });

        const { description, specs2 } = await evaluateWithRetry(productPage, async () => {
          const target = document.querySelector(".product-information-card_showButton__cho9w");
          if (target) {
            target.click();
            await new Promise((resolve) => setTimeout(resolve, 3000));
            const descEl = Array.from(
              document.querySelectorAll(
                ".product-information-card_content__Nf_Hn .product-information-card_subContainer__gQn9A"
              )
            ).find((el) =>
              el.querySelector("h2")?.textContent.includes("Ürün Açıklaması")
            );
            const specs = Array.from(
              document.querySelectorAll(".product-information-card_tableWrapper__mLIy4 div")
            )
              .map((spec) => ({
                name: spec.querySelector("label")?.textContent.trim(),
                value: spec.querySelector("span")?.textContent.trim(),
              }))
              .filter((spec) => spec.name && spec.value);
            return {
              description: descEl?.textContent.trim() || "No description found",
              specs2: specs.length > 0 ? specs : "No specifications found",
            };
          }
          return {
            description: "No description found",
            specs2: "No specifications found",
          };
        });

        const categories = await evaluateWithRetry(productPage, () => {
          const cats = Array.from(
            document.querySelectorAll(".breadcrumb_itemLists__O62id ul li")
          );
          return cats.map((cat) => cat.textContent.trim()).slice(0, -1).join(">");
        });

        const productId = productUrl.match(/-p-(\d+)$/)?.[1] || "";

        const product = {
          title,
          brand,
          price,
          currency,
          url: productUrl,
          images: [image1, ...otherImages].filter(Boolean).join(";"),
          rating,
          shipping_fee,
          description,
          specifications: specs2,
          categories,
          productId,
        };

        products.push(product);
        scrapedProductUrls.add(productUrl);
        console.log(
          `[INFO] Processed product: ${product.title} (${products.length}/${totalProducts})`
        );

        fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));
        await productPage.close();
      } catch (productError) {
        console.error(`[ERROR] Error processing product ${productUrl}:`, productError.message);
        if (productPage) await productPage.close();
      }
    }

    console.log(`[INFO] Processed ${products.length}/${totalProducts} products for ${url}`);
    await page.close();
    return products;
  } catch (error) {
    console.error(`[ERROR] Scraping ${url}:`, error.message);
    if (page) await page.close();
    return [];
  }
};

const scrapeMultipleUrls = async () => {
  try {
    let urls = [];
    if (process.argv[2] === "--file") {
      const filePath = process.argv[3];
      if (!filePath) throw new Error("Provide a file path with --file");
      urls = fs.readFileSync(filePath, "utf-8")
        .split("\n")
        .map((url) => url.trim())
        .filter((url) => url);
    } else {
      urls = process.argv.slice(2);
    }

    if (urls.length === 0) throw new Error("No URLs provided");

    for (const url of urls) {
      if (shouldStop) break;
      console.log(`\n[INFO] Scraping ${url}`);
      await scrapeProductsFromUrl(url);
    }

    if (browser) {
      console.log("[INFO] Closing browser...");
      await browser.close();
    }
    process.exit(0);
  } catch (error) {
    console.error("[ERROR] Main error:", error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
};

scrapeMultipleUrls();
