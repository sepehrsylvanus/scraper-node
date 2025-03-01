const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const outputFilePath = path.join(__dirname, "products.json");

let browser, page;
const getProducts = async () => {
  try {
    browser = await puppeteer.launch({
      headless: false,
      protocolTimeout: 86400000,
    });
    page = await browser.newPage();
    const url = process.argv[2];

    await page.goto(url, { waitUntil: "networkidle2", timeout: 86400000 });
    const content = await page.content();
    const $ = cheerio.load(content);

    const products = [];

    for (let index = 0; index < 4; index++) {
      const element = $(".listProductItem")[index];
      if (element) {
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

        // Fetch product details
        const productPage = await browser.newPage();
        await productPage.goto(url, {
          waitUntil: "networkidle2",
          timeout: 86400000,
        });

        // Wait until the actual image src is loaded
        await productPage.waitForFunction(
          () => {
            const img = document.querySelector(
              ".product-image-layout_imageBig__8TB1z.product-image-layout_lbEnabled__IfV9T span img[data-nimg='intrinsic']"
            );
            return (
              img &&
              img.src.startsWith("https://statics-mp.boyner.com.tr") &&
              !img.src.includes("data:image/svg+xml")
            );
          },
          { timeout: 86400000 }
        );

        const content = await productPage.content();
        const $$ = cheerio.load(content);

        const image1 = $$(
          ".product-image-layout_imageBig__8TB1z.product-image-layout_lbEnabled__IfV9T span img[data-nimg='intrinsic']"
        ).attr("src");

        await productPage.evaluate(() => {
          window.scrollBy(0, 700);
        });
        await productPage.waitForFunction(
          () => {
            const img = document.querySelector(
              ".product-image-layout_otherImages__KwpFh div span img[data-nimg='intrinsic']"
            );
            return (
              img &&
              img.src.startsWith("https://statics-mp.boyner.com.tr") &&
              !img.src.includes("data:image/svg+xml")
            );
          },
          { timeout: 86400000 }
        );

        const images = await productPage.evaluate(() => {
          const images = Array.from(
            document.querySelectorAll(
              ".product-image-layout_otherImages__KwpFh div span img[data-nimg='intrinsic']"
            )
          );
          const imageUrls = images.map((image) => image.src);
          return imageUrls.join(";");
        });

        // Collect additional product details
        const shipping_fee = await productPage.evaluate(async () => {
          const elements = Array.from(
            document.querySelectorAll(".tabs_title__gO9Hr")
          );
          const targetElement = elements.find((el) =>
            el.textContent.includes("Teslimat Bilgileri")
          );

          if (targetElement) {
            targetElement.click();

            await new Promise((resolve) => setTimeout(resolve, 2000));

            const shipping_fee = parseFloat(
              document
                .querySelector(
                  ".delivery-information_wrapper__Ek_Uy div span strong"
                )
                .textContent.trim()
                .match(/(\d+(\.\d+)?)/)[0]
            );

            return shipping_fee;
          }

          return null;
        });

        const returnable = await productPage.evaluate(() => {
          const elements = Array.from(
            document.querySelectorAll(".cargo-status_item__PdgOr span")
          );
          const targetElement = elements.find((el) =>
            el.textContent.includes("İade")
          );

          if (targetElement) {
            return true;
          } else {
            return false;
          }
        });

        const description = await productPage.evaluate(async () => {
          const target = document.querySelector(
            ".product-information-card_showButton__cho9w"
          );
          target.click();
          const desc = document.querySelector(
            ".product-information-card_content__Nf_Hn"
          ).innerHTML;
          return desc;
        });

        const categories = await productPage.evaluate(() => {
          const target = Array.from(
            document.querySelectorAll(".breadcrumb_itemLists__O62id ul li")
          );
          const categories = target.map((el) => el.textContent);
          return categories.join(">");
        });

        await productPage.close();

        // Add product information to products array
        products.push({
          title,
          brand,
          price,
          url,
          shipping_fee,
          currency,
          returnable,
          description,
          categories,
          images: image1 + ";" + images,
        });
      }
    }

    fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));

    await browser.close();
  } catch (error) {
    console.log("Error encountered: ", error.message);
    if (browser) await browser.close();
  }
};

getProducts();
