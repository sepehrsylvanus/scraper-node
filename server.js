const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const outputFilePath = path.join(__dirname, "products.json");
let browser, page;

// Helper function to check if an element is in the viewport
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

// Launch or reconnect to the browser
const launchBrowser = async () => {
  try {
    if (browser && browser.isConnected()) return browser;
    return await puppeteer.launch({
      headless: false, // Set to true for headless mode
      protocolTimeout: 86400000,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  } catch (error) {
    console.error("Error launching browser:", error);
    throw error;
  }
};

// Reconnect to the browser if needed
const reconnectIfNeeded = async () => {
  if (!browser || !browser.isConnected() || !page) {
    console.log("Reconnecting to browser...");
    browser = await launchBrowser();
    page = await browser.newPage();
  }
};

// Scroll the page to load more products
const scrollPage = async () => {
  await page.evaluate(() => {
    window.scrollBy(0, window.innerHeight); // Scroll by one viewport height
  });
  await new Promise((resolve) => setTimeout(resolve, 3000)); // Wait for new products to load
};

// Scrape product details from the product page
const scrapeProductDetails = async (productUrl) => {
  const productPage = await browser.newPage();
  await productPage.goto(productUrl, {
    waitUntil: "networkidle2",
    timeout: 120000,
  });

  // Scroll to trigger lazy loading of images
  await productPage.evaluate(() => window.scrollBy(0, 500));
  await new Promise((resolve) => setTimeout(resolve, 3000));

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
    return images.map((img) => img.getAttribute("src")).join(";") || "";
  });

  const rating = await productPage.evaluate(async () => {
    const ratingModal = document.querySelector(
      ".rating-custom_reviewText__EUE7E"
    );
    if (ratingModal) {
      ratingModal.click();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const rating = parseFloat(
        document.querySelector(".score-summary_score__VrQrb")?.textContent || 0
      );
      document.querySelector(".icon-close")?.click();
      return rating || "No rating";
    }
    return "No rating";
  });

  const shipping_fee = await productPage.evaluate(async () => {
    const target = Array.from(
      document.querySelectorAll(".tabs_title__gO9Hr")
    ).find((element) => element.textContent.includes("Teslimat Bilgileri"));
    if (target) {
      target.click();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const shippingFee = parseFloat(
        document
          .querySelector(".delivery-information_wrapper__Ek_Uy div span strong")
          ?.textContent?.match(/[\d,]+(\.[\d]+)?/)?.[0] || 0
      );
      document.querySelector(".tab-modal_closeIcon__gUYKw")?.click();
      return shippingFee || "No shipping fee";
    }
    return "No shipping fee";
  });

  const { description, specs2 } = await productPage.evaluate(async () => {
    const target = document.querySelector(
      ".product-information-card_showButton__cho9w"
    );
    if (target) {
      target.click();
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const descriptionElements = Array.from(
        document.querySelectorAll(
          ".product-information-card_content__Nf_Hn .product-information-card_subContainer__gQn9A"
        )
      );
      const elementDescription = descriptionElements.find((element) =>
        element.querySelector("h2")?.textContent.includes("Ürün Açıklaması")
      );

      const specs = Array.from(
        document.querySelectorAll(
          ".product-information-card_tableWrapper__mLIy4 div"
        )
      ).map((eachSpec) => {
        const name = eachSpec.querySelector("label")?.textContent?.trim();
        const value = eachSpec.querySelector("span")?.textContent?.trim();
        return { name, value };
      });

      return {
        description:
          elementDescription?.textContent?.trim() || "No description found",
        specs2: specs.length > 0 ? specs : "No specifications found",
      };
    }
    return {
      description: "No description found",
      specs2: "No specifications found",
    };
  });

  const categories = await productPage.evaluate(() => {
    const categories = Array.from(
      document.querySelectorAll(".breadcrumb_itemLists__O62id ul li")
    );
    return categories.map((category) => category.textContent.trim()).join(">");
  });

  await productPage.close();

  return {
    image1,
    otherImages,
    rating,
    shipping_fee,
    description,
    specs2,
    categories,
  };
};

// Main scraping function
const scrapeProducts = async () => {
  try {
    browser = await launchBrowser();
    page = await browser.newPage();
    const url = process.argv[2];

    await page.goto(url, { waitUntil: "networkidle2", timeout: 120000 });
    console.log("Navigated to the page");

    let products = [];
    let scrapedProductUrls = new Set();
    let productCounter = 0;

    while (true) {
      await reconnectIfNeeded();

      const content = await page.content();
      const $ = cheerio.load(content);
      const elements = $(".listProductItem");

      for (const element of elements) {
        const productUrl =
          "https://www.boyner.com.tr/" +
          $(element).find(".product-item_image__IxD4T a").attr("href");

        if (scrapedProductUrls.has(productUrl)) continue;

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

        try {
          const productDetails = await scrapeProductDetails(productUrl);

          const product = {
            title,
            brand,
            price,
            currency,
            productUrl,
            images: `${productDetails.image1};${productDetails.otherImages}`,
            rating: productDetails.rating,
            shipping_fee: productDetails.shipping_fee,
            description: productDetails.description,
            specifications: productDetails.specs2,
            categories: productDetails.categories,
          };

          console.log(`Processing product: ${title}`);
          products.push(product);
          scrapedProductUrls.add(productUrl);
          fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));

          productCounter++;

          // Scroll down after every 4 products
          if (productCounter % 4 === 0) {
            console.log("Scrolling down...");
            await scrollPage();
          }
        } catch (error) {
          console.error(`Error processing product: ${productUrl}`);
          console.error(error.message);
        }
      }

      // Check if the footer is visible
      const footerVisible = await isElementInViewport(
        ".footer-mini-slider_listBox__UzO2D"
      );
      if (footerVisible) {
        console.log("Footer is visible, waiting for new products...");
        await new Promise((resolve) => setTimeout(resolve, 15000));

        const currentProductCount = (await page.$$(".listProductItem")).length;
        if (currentProductCount > scrapedProductUrls.size) {
          console.log("New products found! Continuing...");
        } else {
          console.log("No new products found. Stopping...");
          break;
        }
      } else {
        console.log("Scrolling down to load more products...");
        await scrollPage();
      }
    }

    console.log("Scraping completed.");
    console.log(`Total products processed: ${products.length}`);
    await browser.close();
  } catch (error) {
    console.log("Error encountered:", error.message);
    if (browser) await browser.close();
  }
};

scrapeProducts();
