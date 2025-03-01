const puppeteer = require("puppeteer");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const outputFilePath = path.join(__dirname, "products.json");
const userDataDir = path.join(__dirname, "user_data");

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

        // Click on the desired element and collect information
        const shipping_fee = await productPage.evaluate(async () => {
          const elements = Array.from(
            document.querySelectorAll(".tabs_title__gO9Hr")
          );
          const targetElement = elements.find((el) =>
            el.textContent.includes("Teslimat Bilgileri")
          );

          if (targetElement) {
            targetElement.click();

            // Wait for the modal content to be rendered
            await new Promise((resolve) => setTimeout(resolve, 2000)); // Adjust the timeout based on the modal loading time

            // Collect information from the modal
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

        // Log the collected information

        await productPage.close();

        // Add targetElement information to products
        products.push({
          title,
          brand,
          price,
          url,
          shipping_fee,
          currency,
        });
      }
    }

    // Scroll down
    await page.evaluate(() => window.scrollBy(0, 200));

    // Save products to JSON file
    fs.writeFileSync(outputFilePath, JSON.stringify(products, null, 2));

    await browser.close();
  } catch (error) {
    console.log("Error encountered: ", error.message);
    if (browser) await browser.close();
  }
};

getProducts();
