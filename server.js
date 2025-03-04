const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const outputFilePath = path.join(__dirname, "products.json");
let browser, page;

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
      headless: true,
      protocolTimeout: 86400000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
      ],
    });
  } catch (error) {
    console.error("Error launching browser:", error);
    throw error;
  }
};

const scrapeProducts = async () => {
  try {
    browser = await launchBrowser();
    page = await browser.newPage();
    const url = process.argv[2];
    await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
    console.log("Navigated to the page");

    let products = [];
    let scrapedProductUrls = new Set();
    let productCounter = 0;

    const scrollAndWait = async () => {
      await page.evaluate(() => window.scrollBy(0, 500));
      await new Promise((resolve) => setTimeout(resolve, 2000));
    };

    let previousProductCount = 0;
    let scrollAttempts = 0;
    const maxScrollAttempts = 10;

    while (scrollAttempts < maxScrollAttempts) {
      console.log("Scrolling to load more products...");
      await scrollAndWait();
      const currentProductCount = (await page.$$(".listProductItem")).length;
      if (currentProductCount === previousProductCount) {
        scrollAttempts++;
        console.log(
          `No new products loaded. Attempt ${scrollAttempts}/${maxScrollAttempts}`
        );
      } else {
        scrollAttempts = 0;
        previousProductCount = currentProductCount;
      }
    }

    console.log("All products loaded. Starting extraction...");
    const content = await page.content();
    const $ = cheerio.load(content);
    const elements = $(".listProductItem");

    for (const element of elements) {
      const productUrl =
        "https://www.boyner.com.tr/" +
        $(element).find(".product-item_image__IxD4T a").attr("href");
      if (scrapedProductUrls.has(productUrl)) continue;
      const title = $(element).find(".product-item_name__HVuFo").text().trim();
      const brand = $(element).find(".product-item_brand__LFImW").text().trim();
      const priceMatch = $(element)
        .find(".product-price_checkPrice__NMY9e strong")
        .text()
        .trim()
        .match(/(\d+(\.\d+)?)/);
      const price = priceMatch ? parseFloat(priceMatch[0]) : null;
      const currencyMatch = $(element)
        .find(".product-price_checkPrice__NMY9e strong")
        .text()
        .trim()
        .match(/[^\d\s]+/);
      const currency = currencyMatch ? currencyMatch[0] : null;

      let productPage;
      try {
        productPage = await browser.newPage();
        await productPage.goto(productUrl, {
          waitUntil: "networkidle2",
          timeout: 60000,
        });
        await productPage.evaluate(() => window.scrollBy(0, 200));
        await new Promise((resolve) => setTimeout(resolve, 2500));

        const productContent = await productPage.content();
        const $$ = cheerio.load(productContent);
        const image1 = $$(
          '.product-image-layout_imageBig__8TB1z.product-image-layout_lbEnabled__IfV9T span img[data-nimg="intrinsic"]'
        ).attr("src");

        const otherImages = await productPage.evaluate(() => {
          return (
            Array.from(
              document.querySelectorAll(
                '.product-image-layout_otherImages__KwpFh img[data-nimg="intrinsic"]'
              )
            )
              .map((img) => img.getAttribute("src"))
              .join(";") || ""
          );
        });

        const descriptionData = await productPage.evaluate(() => {
          let description = "No description found";
          let specifications = [];
          const target = document.querySelector(
            ".product-information-card_showButton__cho9w"
          );
          if (target) {
            target.click();
            return new Promise((resolve) =>
              setTimeout(() => {
                const descElement = document.querySelector(
                  ".product-information-card_content__Nf_Hn"
                );
                if (descElement) description = descElement.textContent.trim();
                const specs = document.querySelectorAll(
                  ".product-information-card_tableWrapper__mLIy4 div"
                );
                specifications = Array.from(specs)
                  .map((spec) => ({
                    name: spec.querySelector("label")?.textContent.trim(),
                    value: spec.querySelector("span")?.textContent.trim(),
                  }))
                  .filter((spec) => spec.name && spec.value);
                resolve({ description, specifications });
              }, 2000)
            );
          }
          return { description, specifications };
        });

        const categories = await productPage.evaluate(() => {
          return Array.from(
            document.querySelectorAll(".breadcrumb_itemLists__O62id ul li")
          )
            .map((category) => category.textContent.trim())
            .join(" > ");
        });

        const product = {
          title,
          brand,
          price,
          currency,
          productUrl,
          images: image1 + ";" + otherImages,
          description: descriptionData.description,
          specifications: descriptionData.specifications,
          categories,
        };

        console.log(`Processing product: ${title}`);
        products.push(product);
        scrapedProductUrls.add(productUrl);
        fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));
        await productPage.close();
      } catch (error) {
        console.error(`Error processing product: ${productUrl}`, error.message);
        if (productPage) await productPage.close();
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
