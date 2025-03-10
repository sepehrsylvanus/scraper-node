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
let resetCount = 0;
const MAX_RESETS = 5; // Prevent infinite reset loops

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

const advancedInfiniteScroll = async (page, totalProducts) => {
  console.log("[DEBUG] Entering advancedInfiniteScroll...");
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

  let stuckTime = 0;
  const stuckThreshold = 20000; // 20 seconds
  let lastScrollPosition = 0;
  let scrollStuckTime = 0;
  const scrollStuckThreshold = 30000; // 30 seconds

  while (
    lastProductCount < totalProducts &&
    !shouldStop &&
    resetCount < MAX_RESETS
  ) {
    console.log("[DEBUG] Starting scroll iteration...");
    let currentScrollPosition = 0;
    try {
      currentScrollPosition = await evaluateWithRetry(
        page,
        () => window.scrollY
      );
      console.log(`[DEBUG] Current scroll position: ${currentScrollPosition}`);
    } catch (error) {
      console.error("[ERROR] Failed to get scroll position:", error.message);
      await page.evaluate(() => window.scrollTo(0, 0)); // Reset to top
      continue;
    }

    if (currentScrollPosition === lastScrollPosition) {
      scrollStuckTime += 2000;
      if (scrollStuckTime >= scrollStuckThreshold) {
        console.error(
          `[ERROR] Scroller stuck at position ${currentScrollPosition} for 30 seconds! Resetting...`
        );
        await page.evaluate(() => window.scrollTo(0, 0));
        resetCount++;
        console.log(`[INFO] Reset to top (Reset ${resetCount}/${MAX_RESETS})`);
        scrollStuckTime = 0;
        lastScrollPosition = 0;
        continue;
      }
    } else {
      scrollStuckTime = 0;
      lastScrollPosition = currentScrollPosition;
    }

    try {
      await page.evaluate(() => window.scrollBy(0, 500));
      console.log("[DEBUG] Scrolled by 500px");
    } catch (error) {
      console.error("[ERROR] Scroll execution failed:", error.message);
      await page.evaluate(() => window.scrollTo(0, 0));
      continue;
    }

    let currentProductCount = 0;
    try {
      currentProductCount = await evaluateWithRetry(
        page,
        () => document.querySelectorAll(".listProductItem").length
      );
      console.log(
        `[DEBUG] Product count: ${currentProductCount}/${totalProducts}`
      );
    } catch (error) {
      console.error("[ERROR] Failed to get product count:", error.message);
      await page.evaluate(() => window.scrollTo(0, 0));
      continue;
    }

    if (currentProductCount > lastProductCount) {
      console.log(
        `[INFO] New products loaded: ${currentProductCount}/${totalProducts}`
      );
      lastProductCount = currentProductCount;
      stuckTime = 0;
    } else {
      stuckTime += 2000;
      if (stuckTime >= stuckThreshold) {
        console.log(
          `[INFO] No new products loaded for 20 seconds. Starting reset countdown...`
        );
        let countdown = 20; // Countdown from 20 seconds
        while (countdown > 0 && !shouldStop) {
          process.stdout.write(
            `\r[INFO] Resetting in ${countdown} seconds... (Press 'q' to quit)`
          );
          await delay(1000); // Wait 1 second per countdown step
          countdown--;
        }
        if (!shouldStop) {
          console.log(
            `\n[INFO] Resetting scroll... (${lastProductCount}/${totalProducts})`
          );
          await page.evaluate(() => window.scrollTo(0, 0));
          resetCount++;
          console.log(
            `[INFO] Reset to top (Reset ${resetCount}/${MAX_RESETS})`
          );
          stuckTime = 0;
          lastProductCount = await evaluateWithRetry(
            page,
            () => document.querySelectorAll(".listProductItem").length
          );
        }
      } else {
        const remainingTime = (stuckThreshold - stuckTime) / 1000;
        process.stdout.write(
          `\r[INFO] No progress, stuck for ${
            stuckTime / 1000
          }s (Reset in ${remainingTime}s)`
        );
      }
    }

    if (resetCount >= MAX_RESETS) {
      console.log("[ERROR] Max resets reached, stopping scroll...");
      break;
    }

    if (currentProductCount >= totalProducts) {
      console.log(
        `[INFO] Reached target: ${currentProductCount}/${totalProducts}`
      );
      break;
    }

    await delay(2000);
  }

  return lastProductCount >= totalProducts;
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
        const totalElement = document.querySelector(
          ".product-list_total__TvMCW"
        );
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

    await advancedInfiniteScroll(page, totalProducts);
    console.log("[INFO] Scroll complete, waiting 5 seconds...");
    await delay(5000);

    let products = [];
    let scrapedProductUrls = new Set();
    let productCounter = 0;

    const sanitizedFilename = url
      .replace(/https?:\/\//, "")
      .replace(/[^a-z0-9]/gi, "_")
      .toLowerCase();
    const outputFilePath = path.join(
      outputDir,
      `${sanitizedFilename}_products.json`
    );

    while (!shouldStop && productCounter < totalProducts) {
      console.log(
        `[INFO] Starting scrape pass: ${productCounter}/${totalProducts}`
      );
      let content;
      try {
        content = await page.content();
      } catch (error) {
        console.error("[ERROR] Failed to get page content:", error.message);
        await page.evaluate(() => window.scrollTo(0, -window.innerHeight));
        continue;
      }
      const $ = cheerio.load(content);
      const elements = $(".listProductItem");

      console.log(`[INFO] Found ${elements.length} product elements`);

      let newProductsFound = false;
      for (const element of elements) {
        if (shouldStop) break;
        const productUrl =
          "https://www.boyner.com.tr/" +
          $(element).find(".product-item_image__IxD4T a").attr("href");

        if (scrapedProductUrls.has(productUrl)) {
          console.log(`[INFO] Skipping duplicate: ${productUrl}`);
          continue;
        }

        newProductsFound = true;
        const title = $(element)
          .find(".product-item_name__HVuFo")
          .text()
          .trim();
        const brand = $(element)
          .find(".product-item_brand__LFImW")
          .text()
          .trim();
        const price = parseFloat(
          $(element)
            .find(".product-price_checkPrice__NMY9e strong")
            .text()
            .trim()
            .match(/(\d+(\.\d+)?)/)?.[0] || "0"
        );
        const currency =
          $(element)
            .find(".product-price_checkPrice__NMY9e strong")
            .text()
            .trim()
            .match(/[^\d\s]+/)?.[0] || "";

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
          const image1 = $$(
            '.product-image-layout_imageBig__8TB1z.product-image-layout_lbEnabled__IfV9T span img[data-nimg="intrinsic"]'
          ).attr("src");

          const otherImages = await evaluateWithRetry(productPage, () => {
            window.scrollBy(0, window.innerHeight);
            const spans = document.querySelectorAll(
              "div.grid_productDetail__HCmCI div.grid_productDetailGallery__AvuaZ div.product-image-layout_otherImages__KwpFh div span"
            );
            return Array.from(spans)
              .map((span) => {
                const img = span.querySelector('img[data-nimg="intrinsic"]');
                return img && !img.src.startsWith("data:image")
                  ? img.src
                  : null;
              })
              .filter((src) => src);
          });
          const rating = await evaluateWithRetry(productPage, async () => {
            const ratingModal = document.querySelector(
              ".rating-custom_reviewText__EUE7E"
            );
            if (ratingModal) {
              ratingModal.click();
              await new Promise((resolve) => setTimeout(resolve, 3000));
              const score = document.querySelector(
                ".score-summary_score__VrQrb"
              );
              const rating = score
                ? parseFloat(score.textContent)
                : "No rating";
              document.querySelector(".icon-close")?.click();
              return rating;
            }
            return "No rating";
          });

          const shipping_fee = await evaluateWithRetry(
            productPage,
            async () => {
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
            }
          );

          const { description, specs2 } = await evaluateWithRetry(
            productPage,
            async () => {
              const target = document.querySelector(
                ".product-information-card_showButton__cho9w"
              );
              if (target) {
                target.click();
                await new Promise((resolve) => setTimeout(resolve, 3000));
                const descEl = Array.from(
                  document.querySelectorAll(
                    ".product-information-card_content__Nf_Hn .product-information-card_subContainer__gQn9A"
                  )
                ).find((el) =>
                  el
                    .querySelector("h2")
                    ?.textContent.includes("Ürün Açıklaması")
                );
                const specs = Array.from(
                  document.querySelectorAll(
                    ".product-information-card_tableWrapper__mLIy4 div"
                  )
                )
                  .map((spec) => ({
                    name: spec.querySelector("label")?.textContent.trim(),
                    value: spec.querySelector("span")?.textContent.trim(),
                  }))
                  .filter((spec) => spec.name && spec.value);
                return {
                  description:
                    descEl?.textContent.trim() || "No description found",
                  specs2: specs.length > 0 ? specs : "No specifications found",
                };
              }
              return {
                description: "No description found",
                specs2: "No specifications found",
              };
            }
          );

          const categories = await evaluateWithRetry(productPage, () => {
            const cats = Array.from(
              document.querySelectorAll(".breadcrumb_itemLists__O62id ul li")
            );
            return cats
              .map((cat) => cat.textContent.trim())
              .slice(0, -1)
              .join(">");
          });

          const productId = productUrl.match(/-p-(\d+)$/)?.[1] || "";

          const product = {
            title,
            brand,
            price,
            currency,
            url: productUrl,
            images: [image1, ...otherImages].join(";"),
            rating,
            shipping_fee,
            description,
            specifications: specs2,
            categories,
            productId,
          };

          console.log(
            `[INFO] Processed product: ${product.title} (${
              productCounter + 1
            }/${totalProducts})`
          );
          products.push(product);
          scrapedProductUrls.add(productUrl);
          productCounter++;

          fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));
          await productPage.close();
        } catch (productError) {
          console.error(
            `[ERROR] Error processing product ${productUrl}:`,
            productError.message
          );
          if (productPage) await productPage.close();
        }
      }

      if (productCounter < totalProducts) {
        let currentLoaded = 0;
        try {
          currentLoaded = await evaluateWithRetry(
            page,
            () => document.querySelectorAll(".listProductItem").length
          );
          console.log(`[DEBUG] Current loaded products: ${currentLoaded}`);
        } catch (error) {
          console.error("[ERROR] Failed to check loaded count:", error.message);
          await page.evaluate(() => window.scrollTo(0, -window.innerHeight));
          continue;
        }
        if (!newProductsFound || currentLoaded === elements.length) {
          console.log(
            `[INFO] No new products, scrolling... (${productCounter}/${totalProducts})`
          );
          await advancedInfiniteScroll(page, totalProducts);
          await delay(3000);
        } else {
          console.log(
            `[INFO] Continuing scroll... (${productCounter}/${totalProducts})`
          );
          await advancedInfiniteScroll(page, totalProducts);
          await delay(3000);
        }
      }
    }

    console.log(
      `[INFO] Processed ${productCounter}/${totalProducts} products for ${url}`
    );
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
      urls = fs
        .readFileSync(filePath, "utf-8")
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
