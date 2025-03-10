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

const scrollUntilVisible = async (page, selector) => {
  try {
    let isVisible = false;
    let scrollAttempts = 0;
    const maxScrollAttempts = 20;

    while (!isVisible && scrollAttempts < maxScrollAttempts) {
      const element = await page.$(selector);
      if (!element) {
        console.log(
          `Element with selector ${selector} not found after ${scrollAttempts} attempts.`
        );
        return false;
      }

      const isElementVisible = await page.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      }, element);

      if (isElementVisible) {
        isVisible = true;
      } else {
        await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight / 2);
        });
        await delay(500);
        scrollAttempts++;
      }
    }
    return isVisible;
  } catch (error) {
    console.error(
      `Error in scrollUntilVisible for selector ${selector}:`,
      error
    );
    return false;
  }
};

const extractProductUrls = async (page) => {
  try {
    const productUrls = await page.evaluate(() => {
      const productElements = Array.from(
        document.querySelectorAll("app-custom-product-grid-item")
      );
      return productElements
        .map((element) => {
          const productLink = element.querySelector(".infos .cx-product-name");
          if (productLink && productLink.getAttribute("href")) {
            return "https://www.gratis.com" + productLink.getAttribute("href");
          }
          return null;
        })
        .filter((url) => url !== null);
    });
    console.log(`Found ${productUrls.length} product URLs on current page`);
    return productUrls;
  } catch (error) {
    console.error("Error extracting product URLs:", error);
    return [];
  }
};

const scrapeProductDetails = async (page, url) => {
  try {
    console.log(`Navigating to product: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2" });
    await delay(2000);

    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await delay(2000);

    const productIdMatch = url.match(/-p-(\d+)$/);
    const productId = productIdMatch ? productIdMatch[1] : null;

    const details = await page.evaluate(() => {
      const brand =
        document.querySelector(".manufacturer")?.textContent.trim() || null;

      const titleElement = document.querySelector(".product-title");
      let title = null;
      if (titleElement) {
        const titleParts = titleElement.textContent.trim().split(" ");
        title = titleParts.slice(1).join(" ") || null;
      }

      const priceWhole =
        document.querySelector(".price .discounted")?.textContent.trim() ||
        null;
      const priceFraction =
        document.querySelector(".price .sm")?.textContent.trim() || null;
      const completePrice =
        priceWhole && priceFraction ? `${priceWhole}${priceFraction}` : null;
      const currency =
        document.querySelector(".price .thin")?.textContent.trim() || null;

      const swiperImages = Array.from(
        document.querySelectorAll(".swiper-slide img")
      )
        .map((img) => img.getAttribute("src"))
        .filter((src) => src && !src.includes("gratis-placeholder.svg"));
      const images = swiperImages.length > 0 ? swiperImages.join(";") : null;

      const ratingElement = document.querySelector(
        ".JetR-inline-ratingOrCount"
      );
      const ratingText = ratingElement?.textContent.trim() || null;
      const rating = ratingText
        ? parseFloat(ratingText.replace(/[()]/g, ""))
        : null;

      // Use innerHTML for description
      const descriptionElement = document.querySelector(
        ".pdp-detail-tab-content"
      );
      let description = null;
      if (descriptionElement) {
        const fullHTML = descriptionElement.innerHTML.trim();
        const titleMatch = fullHTML.match(/^<b>.*?<\/b>/i); // Match <b> tag and its content
        if (titleMatch) {
          description = fullHTML
            .replace(titleMatch[0], "") // Remove the <b> title
            .replace(/^(\s*<br\s*\/?>\s*)+/, "") // Remove leading <br> tags
            .trim();
        } else {
          description = fullHTML;
        }
      }

      const specsTable = document.querySelector(".specs-table");
      let specifications = null;
      if (specsTable) {
        specifications = Array.from(specsTable.querySelectorAll("tbody tr"))
          .map((row) => {
            const cells = row.querySelectorAll("td");
            if (cells.length === 2) {
              return {
                name: cells[0].textContent.trim(),
                value: cells[1].textContent.trim(),
              };
            }
            return null;
          })
          .filter((spec) => spec !== null);
      }

      const breadcrumbItems = document.querySelectorAll(
        ".breadcrumb .breadcrumb-item a"
      );
      let categories = null;
      if (breadcrumbItems.length > 1) {
        const categoryNames = Array.from(breadcrumbItems)
          .slice(0, -1)
          .map((item) => item.textContent.trim());
        categories = categoryNames.join(">");
      }

      return {
        brand,
        title,
        price: completePrice,
        currency,
        url: window.location.href,
        images,
        rating,
        description,
        specifications,
        categories,
      };
    });

    const productDetails = {
      ...details,
      productId,
    };

    console.log(
      `Scraped product: ${productDetails.title} with productId: ${productDetails.productId}`
    );
    return productDetails;
  } catch (error) {
    console.error(`Error scraping product at ${url}:`, error);
    const productIdMatch = url.match(/-p-(\d+)$/);
    const productId = productIdMatch ? productIdMatch[1] : null;
    return {
      brand: null,
      title: null,
      price: null,
      currency: null,
      url,
      images: null,
      rating: null,
      description: null,
      specifications: null,
      categories: null,
      productId,
      error: error.message,
    };
  }
};

const scrapePagination = async (page, baseUrl) => {
  let currentPage = 1;
  const urlParts = baseUrl.split("?");
  const baseUrlWithoutPage = urlParts[0];
  const outputFileName = path.join(
    outputDir,
    `${baseUrlWithoutPage
      .replace(/https?:\/\/|www\.|\.com\//g, "")
      .replace(/\//g, "_")}_${dateStr}.json`
  );

  let allProducts = [];

  if (fs.existsSync(outputFileName)) {
    try {
      const existingData = fs.readFileSync(outputFileName, "utf8");
      allProducts = JSON.parse(existingData);
      console.log(
        `Loaded ${allProducts.length} existing products from ${outputFileName}`
      );
    } catch (error) {
      console.error(
        `Error loading existing data from ${outputFileName}:`,
        error
      );
    }
  }

  console.log(`Starting with URL: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  await delay(3000);

  const totalProducts = await page.evaluate(() => {
    const infoElement = document.querySelector(".sorting-header .info");
    if (infoElement) {
      const text = infoElement.textContent.trim();
      const match = text.match(/(\d+)/);
      return match ? parseInt(match[1], 10) : 0;
    }
    return 0;
  });
  console.log(`Total products to scrape: ${totalProducts}`);

  while (!shouldStop) {
    console.log(`Scraping page ${currentPage}...`);
    const productUrls = await extractProductUrls(page);

    if (productUrls.length === 0) {
      console.log("No products found on this page.");
    } else {
      const productPage = await browser.newPage();
      for (const productUrl of productUrls) {
        const productDetails = await scrapeProductDetails(
          productPage,
          productUrl
        );
        if (productDetails) {
          allProducts.push(productDetails);
          fs.writeFileSync(
            outputFileName,
            JSON.stringify(allProducts, null, 2)
          );
          console.log(
            `Progress: ${allProducts.length}/${totalProducts} products scraped`
          );
        }
      }
      await productPage.close();
    }

    if (allProducts.length >= totalProducts) {
      console.log(
        `Reached total product count (${totalProducts}). Ending scraping.`
      );
      break;
    }

    const nextButton = await page.$(".pagination .type-next:not(.disabled)");
    if (!nextButton) {
      console.log("No next button found or it’s disabled. Ending scraping.");
      break;
    }

    await scrollUntilVisible(page, ".pagination .type-next");
    console.log(`Navigating to page ${currentPage + 1}`);
    try {
      await Promise.all([
        page.click(".pagination .type-next"),
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      ]);
    } catch (error) {
      console.error(`Error navigating to next page: ${error.message}`);
      break;
    }

    await delay(3000);
    currentPage++;
  }

  console.log(
    `Pagination scraping finished for ${baseUrl}. Scraped ${allProducts.length} out of ${totalProducts} products.`
  );
  console.log(`Results saved to ${outputFileName}`);
};

const scrapeMultipleUrls = async () => {
  const urls = process.argv.slice(2);

  if (urls.length === 0) {
    console.error(
      "No URLs provided. Usage: node gratis.js <url1> <url2> <url3> ..."
    );
    process.exit(1);
  }

  try {
    browser = await launchBrowser();

    for (const baseUrl of urls) {
      console.log(`Starting scraping for: ${baseUrl}`);
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });
      await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
      );

      await scrapePagination(page, baseUrl);
      await page.close();
      console.log(`Finished scraping for: ${baseUrl}\n`);
      shouldStop = false;
    }

    await browser.close();
    console.log("All URLs processed successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Error during scraping:", error);
    if (browser) await browser.close();
    process.exit(1);
  }
};

process.on("SIGINT", async () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  shouldStop = true;
  if (browser) await browser.close();
  process.exit(0);
});

scrapeMultipleUrls();
