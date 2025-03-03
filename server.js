const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const outputFilePath = path.join(__dirname, "products.json");
let browser, page;

// Define the isElementInViewport function
const isElementInViewport = async (selector) => {
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
      args: ["--no-sandbox", "--disable-setuid-sandbox"], // Useful for preventing crashes
    });
  } catch (error) {
    console.error("Error launching browser:", error);
    throw error;
  }
};

const reconnectIfNeeded = async () => {
  // If the page is no longer available or the browser is disconnected, reconnect
  if (!browser || !browser.isConnected() || !page) {
    console.log("Reconnecting to browser...");
    browser = await launchBrowser();
    page = await browser.newPage();
  }
};

const scrapeProducts = async () => {
  try {
    // Start the browser and open a page
    browser = await launchBrowser();
    page = await browser.newPage();
    const url = process.argv[2];

    // Ensure we reconnect if needed and set a longer timeout
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

    console.log("Navigated to the page");

    let products = [];
    let scrapedProductUrls = new Set(); // Track scraped URLs to avoid duplicates
    let productCounter = 0; // Counter to track processed products

    while (true) {
      console.log("Extracting product information...");
      await reconnectIfNeeded(); // Reconnect to the browser and page if necessary

      const content = await page.content();
      const $ = cheerio.load(content);
      const elements = $(".listProductItem");

      for (const element of elements) {
        const productUrl =
          "https://www.boyner.com.tr/" +
          $(element).find(".product-item_image__IxD4T a").attr("href");

        if (scrapedProductUrls.has(productUrl)) continue; // Skip if already scraped

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

        // Open a new page for the product and ensure it works
        let productPage;
        try {
          productPage = await browser.newPage();
          await productPage.goto(productUrl, {
            waitUntil: "networkidle2",
            timeout: 60000,
          });

          // Scroll down a bit to trigger lazy loading of images
          await productPage.evaluate(() => {
            window.scrollBy(0, 500); // Adjust the scroll amount as needed
          });
          await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for images to load

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
              await new Promise((resolve) => setTimeout(() => resolve(), 2000));
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
              await new Promise((resolve) => setTimeout(() => resolve(), 2000));
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
                  setTimeout(() => resolve(), 2000)
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
          };

          console.log(`Processing product: ${title}`);
          products.push(product);
          scrapedProductUrls.add(productUrl); // Mark this product as scraped

          // Save the product immediately to the file
          fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));

          // Close the product page
          await productPage.close();

          // Increment the product counter
          productCounter++;

          // Scroll down after every 4 products
          if (productCounter % 4 === 0) {
            console.log("Scrolling down 200px...");
            await page.evaluate(() => window.scrollBy(0, 200));
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } catch (productError) {
          console.error(`Error processing product: ${productUrl}`);
          console.error(productError.message);
          if (productPage) await productPage.close(); // Ensure the product page is closed
        }
      }

      // Check if the footer is visible
      const footerVisible = await isElementInViewport(
        ".footer-mini-slider_listBox__UzO2D"
      );
      if (footerVisible) {
        console.log(
          "Footer is visible, waiting 10 seconds for new products to load..."
        );
        await new Promise((resolve) => setTimeout(resolve, 10000));

        // Check if new products have been loaded
        const currentProductCount = (await page.$$(".listProductItem")).length;
        if (currentProductCount > scrapedProductUrls.size) {
          console.log("New products found! Continuing...");
        } else {
          console.log("No new products found after 10 seconds. Stopping...");
          break;
        }
      } else {
        // If the footer is not visible, scroll down and wait for new products
        console.log("Scrolling down to load more products...");
        await page.evaluate(() => window.scrollBy(0, 500));
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Check if new products have been loaded after scrolling
        const currentProductCount = (await page.$$(".listProductItem")).length;
        if (currentProductCount > scrapedProductUrls.size) {
          console.log("New products found! Continuing...");
        } else {
          console.log("No new products found after scrolling. Stopping...");
          break;
        }
      }
    }

    console.log("Scraping completed.");
    console.log(`Total products processed: ${products.length}`); // Log the number of products processed
    await browser.close();
  } catch (error) {
    console.log("Error encountered:", error.message);
    if (browser) await browser.close();
  }
};

scrapeProducts();
