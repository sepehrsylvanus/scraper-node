const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const outputFilePath = path.join(__dirname, "products.json");
let browser, page;
let shouldStop = false;

// Enable keyboard interrupt handling
readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// Capture 'q' key press
process.stdin.on("data", (key) => {
  if (key.toString().trim().toLowerCase() === "q") {
    console.log("\nReceived quit signal. Stopping scraping...");
    shouldStop = true;
  }
});

// Make sure stdin is in raw mode to capture key presses
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.resume();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isElementInViewport = async (page, selector) => {
  return await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <=
        (window.innerHeight || document.documentElement.clientHeight) &&
      rect.right <= (window.innerWidth || document.documentElement.clientWidth)
    );
  }, selector);
};

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

const advancedInfiniteScroll = async (page) => {
  console.log("Starting advanced infinite scroll...");
  return await page.evaluate(async () => {
    return await new Promise((resolve) => {
      let totalHeight = 0;
      const scrollDistance = 1000;
      const maxScrollAttempts = 20;
      let scrollAttempts = 0;
      let lastHeight = document.body.scrollHeight;

      const scrollInterval = setInterval(() => {
        // Scroll down
        window.scrollBy(0, scrollDistance);
        totalHeight += scrollDistance;
        scrollAttempts++;

        // Check for new content loading
        const currentHeight = document.body.scrollHeight;
        const newContentLoaded = currentHeight > lastHeight;

        // Check for RFM marquee or other lazy load indicators
        const marqueeVisible = document.querySelector(".rfm-marquee") !== null;

        if (newContentLoaded) {
          console.log("New content detected!");
          lastHeight = currentHeight;
          scrollAttempts = 0; // Reset attempts when new content is found
        }

        // Stop conditions
        if (
          scrollAttempts >= maxScrollAttempts ||
          totalHeight >= currentHeight * 2
        ) {
          clearInterval(scrollInterval);
          resolve(true);
        }
      }, 500);
    });
  });
};

const scrapeProducts = async () => {
  try {
    browser = await launchBrowser();
    page = await browser.newPage();
    const url = process.argv[2];

    if (!url) {
      console.error("Please provide a URL as an argument");
      process.exit(1);
    }

    // Configure page to load faster and handle lazy loading
    await page.setDefaultNavigationTimeout(120000);
    await page.setDefaultTimeout(120000);

    await page.goto(url, {
      waitUntil: ["networkidle0", "domcontentloaded"],
      timeout: 120000,
    });
    console.log("Navigated to the page");
    console.log("Press 'q' at any time to stop scraping");

    // Scroll and wait for content to load
    await advancedInfiniteScroll(page);
    await delay(5000);

    let products = [];
    let scrapedProductUrls = new Set();
    let productCounter = 0;
    const MAX_ITERATIONS = 20;
    let iterations = 0;

    while (!shouldStop && iterations < MAX_ITERATIONS) {
      console.log(`Iteration ${iterations + 1}`);

      // Check if RFM marquee is visible and trigger additional scrolling
      const isMarqueeVisible = await isElementInViewport(page, ".rfm-marquee");
      if (isMarqueeVisible) {
        console.log("RFM Marquee detected. Attempting additional scroll.");
        await advancedInfiniteScroll(page);
        await delay(3000);
      }

      const content = await page.content();
      const $ = cheerio.load(content);
      const elements = $(".listProductItem");

      console.log(`Total product elements found: ${elements.length}`);

      for (const element of elements) {
        if (shouldStop) break;
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
            .match(/(\d+(\.\d+)?)/)[0]
        );
        const currency = $(element)
          .find(".product-price_checkPrice__NMY9e strong")
          .text()
          .trim()
          .match(/[^\d\s]+/)[0];
        const productUrl =
          "https://www.boyner.com.tr/" +
          $(element).find(".product-item_image__IxD4T a").attr("href");

        if (scrapedProductUrls.has(productUrl)) continue;

        let productPage;
        try {
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

          const otherImages = await productPage.evaluate(() => {
            const images = Array.from(
              document.querySelectorAll(
                '.product-image-layout_otherImages__KwpFh .product-image-layout_imageSmall__gQdZ_ span img[data-nimg="intrinsic"]'
              )
            );
            const imgUrls = images.map((img) => img.getAttribute("src"));
            return imgUrls.join(";") || ""; // Return empty string if no images
          });

          const rating = await productPage.evaluate(async () => {
            const ratingModal = document.querySelector(
              ".rating-custom_reviewText__EUE7E"
            );
            if (ratingModal) {
              ratingModal.click();
              await new Promise((resolve) => setTimeout(() => resolve(), 3000));
              const rating = parseFloat(
                document.querySelector(".score-summary_score__VrQrb")
              );
              const closeBtn = document.querySelector(".icon-close");
              closeBtn.click();
              return rating || "No rating"; // Default if no rating
            } else {
              return "No rating"; // Return default value if modal doesn't exist
            }
          });

          const shipping_fee = await productPage.evaluate(async () => {
            const target = Array.from(
              document.querySelectorAll(".tabs_title__gO9Hr")
            ).find((element) =>
              element.textContent.includes("Teslimat Bilgileri")
            );
            if (target) {
              target.click();
              await new Promise((resolve) => setTimeout(() => resolve(), 3000));
              const shippingFee = parseFloat(
                document
                  .querySelector(
                    ".delivery-information_wrapper__Ek_Uy div span strong"
                  )
                  .textContent.match(/[\d,]+(\.[\d]+)?/)[0]
              );
              const closeBtn = document.querySelector(
                ".tab-modal_closeIcon__gUYKw"
              );
              closeBtn.click();
              return shippingFee || "No shipping fee"; // Return default if no shipping fee found
            } else {
              return "No shipping fee"; // Return default if element doesn't exist
            }
          });

          const { description, specs2 } = await productPage.evaluate(
            async () => {
              let elementDescription, specification;

              const target = document.querySelector(
                ".product-information-card_showButton__cho9w"
              );
              if (target) {
                target.click();
                await new Promise((resolve) =>
                  setTimeout(() => resolve(), 3000)
                );

                // Get description
                const descriptionElements = Array.from(
                  document.querySelectorAll(
                    ".product-information-card_content__Nf_Hn .product-information-card_subContainer__gQn9A"
                  )
                );
                elementDescription = descriptionElements.find(
                  (element) =>
                    element.querySelector("h2") &&
                    element
                      .querySelector("h2")
                      .textContent.includes("Ürün Açıklaması")
                );

                // Get specifications
                const specs = Array.from(
                  document.querySelectorAll(
                    ".product-information-card_tableWrapper__mLIy4 div"
                  )
                );
                specification = specs
                  .map((eachSpec) => {
                    const name = eachSpec
                      .querySelector("label")
                      ?.textContent?.trim();
                    const value = eachSpec
                      .querySelector("span")
                      ?.textContent?.trim();
                    return { name, value };
                  })
                  .filter((spec) => spec.name && spec.value); // Filter out empty or incomplete specs
              }

              // Return values, ensure that description and specs2 are properly handled
              return {
                description: elementDescription
                  ? elementDescription.textContent.trim()
                  : "No description found",
                specs2:
                  specification.length > 0
                    ? specification
                    : "No specifications found",
              };
            }
          );

          const categories = await productPage.evaluate(() => {
            const categories = Array.from(
              document.querySelectorAll(".breadcrumb_itemLists__O62id ul li")
            );
            const categoriesText = categories.map((category) =>
              category.textContent.trim()
            );
            return categoriesText.join(">");
          });
          // Your existing product scraping logic
          const product = {
            title,
            brand,
            price,
            currency,
            productUrl,
            images: image1 + ";" + otherImages,
            rating,
            shipping_fee,
            description,
            specifications: specs2,
            categories,
          };

          console.log(`Processing product: ${product.title}`);
          products.push(product);
          scrapedProductUrls.add(productUrl);

          // Save products to file periodically
          fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));

          await productPage.close();
          productCounter++;
        } catch (productError) {
          console.error(`Error processing product: ${productUrl}`);
          console.error(productError.message);
          if (productPage) await productPage.close();
        }
      }

      // Scroll and wait for potential new content
      await advancedInfiniteScroll(page);
      await delay(3000);

      iterations++;
      console.log(`Total products processed so far: ${productCounter}`);

      // Additional stop condition if no progress
      if (iterations >= MAX_ITERATIONS) {
        console.log("Reached maximum iterations. Stopping scraping.");
        break;
      }

      if (shouldStop) break;
    }

    console.log(`Total products processed: ${productCounter}`);

    // Save final results
    fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));

    await browser.close();
    process.exit(0);
  } catch (error) {
    console.log("Error encountered:", error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
};

scrapeProducts();
