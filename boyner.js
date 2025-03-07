const puppeteer = require("puppeteer");

const cheerio = require("cheerio");

const fs = require("fs");

const path = require("path");

const readline = require("readline");

const outputDir = path.join(__dirname, "output");

// Ensure output directory exists

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

let browser;

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

  // Get expected total product count
  const totalExpectedProducts = await page.evaluate(() => {
    const totalElement = document.querySelector(".product-list_total__TvMCW");
    if (totalElement) {
      const match = totalElement.textContent.match(/\d+/);
      return match ? parseInt(match[0], 10) : 500;
    }
    return 500; // Default fallback
  });

  console.log(`Expected total products: ${totalExpectedProducts}`);

  let lastProductCount = 0;
  let noChangeCount = 0;
  const maxNoChangeRetries = 5;

  // Function to gradually scroll down by 100px per step
  const slowScroll = async () => {
    await page.evaluate(async () => {
      return new Promise((resolve) => {
        let scrollStep = 100;
        let scrollInterval = setInterval(() => {
          window.scrollBy(0, scrollStep);
          if (
            window.innerHeight + window.scrollY >=
            document.body.scrollHeight
          ) {
            clearInterval(scrollInterval);
            resolve();
          }
        }, 200); // Scroll every 200ms
      });
    });
    await delay(2000); // Wait after each full scroll event
  };

  // Scroll loop
  while (noChangeCount < maxNoChangeRetries) {
    await slowScroll();

    // Try clicking "Show More" button if present
    const hasMoreButton = await page.evaluate(() => {
      const showMoreBtn = document.querySelector(
        ".product-list_showMoreButton__eS2_Z"
      );
      if (showMoreBtn && showMoreBtn.offsetParent !== null) {
        showMoreBtn.click();
        return true;
      }
      return false;
    });

    if (hasMoreButton) {
      console.log("Clicked 'Show More' button");
      await delay(3000);
    }

    // Count loaded products
    const currentProductCount = await page.evaluate(() => {
      return document.querySelectorAll(".listProductItem").length;
    });

    console.log(
      `Found ${currentProductCount} / ${totalExpectedProducts} products`
    );

    // Handle scrolling being stuck
    if (currentProductCount === lastProductCount) {
      noChangeCount++;
      console.log(
        `No new products loaded. Retry ${noChangeCount}/${maxNoChangeRetries}`
      );

      // Scroll up a bit and back down to trigger lazy loading
      await page.evaluate(() => {
        window.scrollBy(0, -200);
      });
      await delay(500);
      await page.evaluate(() => {
        window.scrollBy(0, 200);
      });

      await delay(2000);
    } else {
      noChangeCount = 0;
    }

    lastProductCount = currentProductCount;

    // Stop if we found all products
    if (currentProductCount >= totalExpectedProducts) {
      console.log("Found all expected products!");
      break;
    }
  }

  // Final product count
  const finalProductCount = await page.evaluate(() => {
    return document.querySelectorAll(".listProductItem").length;
  });

  console.log(
    `Finished scrolling. Found ${finalProductCount} products in total.`
  );
  return true;
};

// Helper function to add delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const scrapeProductsFromUrl = async (page, url) => {
  try {
    // Configure page to load faster and handle lazy loading

    await page.setDefaultNavigationTimeout(120000);

    await page.setDefaultTimeout(120000);

    await page.goto(url, {
      waitUntil: ["networkidle0", "domcontentloaded"],

      timeout: 120000,
    });

    console.log(`Navigated to the page: ${url}`); // Scroll and wait for content to load

    await advancedInfiniteScroll(page);

    await delay(5000);

    let products = [];

    let scrapedProductUrls = new Set();

    let productCounter = 0;

    const MAX_ITERATIONS = 2;

    let iterations = 0; // Create a sanitized filename from the URL

    const sanitizedFilename = url

      .replace(/https?:\/\//, "")

      .replace(/[^a-z0-9]/gi, "_")

      .toLowerCase();

    const outputFilePath = path.join(
      outputDir,

      `${sanitizedFilename}_products.json`
    );

    while (!shouldStop && iterations < MAX_ITERATIONS) {
      console.log(`Iteration ${iterations + 1}`); // Check if RFM marquee is visible and trigger additional scrolling

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

        const url =
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
            window.scrollBy(0, window.innerHeight);

            const spans = document.querySelectorAll(
              "div.grid_productDetail__HCmCI div.grid_productDetailGallery__AvuaZ div.product-image-layout_otherImages__KwpFh div span "
            );

            const imageSrcs = Array.from(spans).map((span) => {
              const img = span.querySelector('img[data-nimg="intrinsic"]');

              if (img && !img.src.startsWith("data:image")) {
                return img.getAttribute("src");
              }

              const noscript = span.querySelector("noscript");

              if (noscript) {
                const tempDiv = document.createElement("div");

                tempDiv.innerHTML = noscript.innerHTML;

                const noscriptImg = tempDiv.querySelector("img");

                if (noscriptImg) {
                  return noscriptImg.getAttribute("src");
                }
              }

              return null;
            });

            return imageSrcs.filter((src) => src !== null); // Extract src directly from images with data-nimg="intrinsic" // const imgUrls = images //   .map((img) => { //     // Prioritize actual image source over placeholder //     const src = img.getAttribute("src"); //     return src && !src.startsWith("data:") ? src : null; //   }) //   .filter((src) => src); // Remove null values // return imgUrls.join(";") || ""; // Return empty string if no images
          });

          console.log({ otherImages });

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
                ); // Get description

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
                ); // Get specifications

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
              } // Return values, ensure that description and specs2 are properly handled

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

            return categoriesText.slice(0, -1).join(">");
          });

          const productId = productUrl.match(/-p-(\d+)$/)[1];

          const product = {
            title,

            brand,

            price,

            currency,

            url,

            images: image1 + ";" + otherImages,

            rating,

            shipping_fee,

            description,

            specifications: specs2,

            categories,

            productId,
          };

          console.log(`Processing product: ${product.title}`);

          products.push(product);

          scrapedProductUrls.add(productUrl); // Save products to file periodically

          fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));

          await productPage.close();

          productCounter++;
        } catch (productError) {
          console.error(`Error processing product: ${productUrl}`);

          console.error(productError.message);

          if (productPage) await productPage.close();
        }
      } // Scroll and wait for potential new content

      await advancedInfiniteScroll(page);

      await delay(3000);

      iterations++;

      console.log(`Total products processed so far: ${productCounter}`); // Additional stop condition if no progress

      if (iterations >= MAX_ITERATIONS) {
        console.log("Reached maximum iterations. Stopping scraping.");

        break;
      }

      if (shouldStop) break;
    }

    console.log(`Total products processed for ${url}: ${productCounter}`);

    return products;
  } catch (error) {
    console.error(`Error scraping ${url}:`, error.message);

    return [];
  }
};

const scrapeMultipleUrls = async () => {
  try {
    // Determine input source

    let urls = [];

    if (process.argv[2] === "--file") {
      // Read URLs from a file

      const filePath = process.argv[3];

      if (!filePath) {
        console.error("Please provide a file path with URLs when using --file");

        process.exit(1);
      }

      urls = fs

        .readFileSync(filePath, "utf-8")

        .split("\n")

        .map((url) => url.trim())

        .filter((url) => url); // Remove empty lines
    } else {
      // Use URLs from command-line arguments

      urls = process.argv.slice(2);
    }

    if (urls.length === 0) {
      console.error("Please provide URLs as arguments or in a file");

      process.exit(1);
    } // Launch browser once

    browser = await launchBrowser(); // Process each URL

    for (const url of urls) {
      if (shouldStop) break;

      console.log(`\n--- Starting scraping for URL: ${url} ---`);

      const page = await browser.newPage();

      try {
        await scrapeProductsFromUrl(page, url);
      } catch (urlError) {
        console.error(`Error processing URL ${url}:`, urlError.message);
      } finally {
        await page.close();
      }
    } // Close browser

    await browser.close();

    process.exit(0);
  } catch (error) {
    console.error("Overall scraping error:", error);

    if (browser) await browser.close();

    process.exit(1);
  }
};

scrapeMultipleUrls();
