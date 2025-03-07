const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");

const outputDir = path.join(__dirname, "output");
// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

let browser;
let shouldStop = false;

// Helper functions
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
    // Scroll the page until the selector is visible
    let isVisible = false;
    let scrollAttempts = 0;
    const maxScrollAttempts = 20; // Prevent infinite scrolling

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
          window.scrollBy(0, window.innerHeight / 2); // Scroll down half a screen height
        });
        await delay(500); // Wait before checking again
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
    // Get all product URLs from the current page based on the provided HTML structure
    const productUrls = await page.evaluate(() => {
      // Target app-custom-product-grid-item elements
      const productElements = Array.from(
        document.querySelectorAll("app-custom-product-grid-item")
      );

      return productElements
        .map((element) => {
          // Find the product link in the infos section
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
    // Navigate to the product page
    console.log(`Navigating to product: ${url}`);
    await page.goto(url, { waitUntil: "networkidle2" });
    await delay(2000);

    // Extract product details
    const productDetails = await page.evaluate(() => {
      // Use document querySelector for proper element selection
      const brand =
        document.querySelector(".manufacturer")?.textContent.trim() || "";

      const titleElement = document.querySelector(".product-title");
      let title = "";
      if (titleElement) {
        // Split by space and remove the first word (typically the brand name)
        const titleParts = titleElement.textContent.trim().split(" ");
        title = titleParts.slice(1).join(" ");
      }

      const priceWhole =
        document.querySelector(".price .discounted")?.textContent.trim() || "";
      const priceFraction =
        document.querySelector(".price .sm")?.textContent.trim() || "";
      const completePrice = `${priceWhole}${priceFraction}`;

      return {
        brand,
        title,
        completePrice,
        url: window.location.href,
      };
    });

    console.log(`Scraped product: ${productDetails.title}`);
    return productDetails;
  } catch (error) {
    console.error(`Error scraping product at ${url}:`, error);
    return {
      brand: "",
      title: "",
      completePrice: "",
      url,
      error: error.message,
    };
  }
};

const scrapePagination = async (page, baseUrl) => {
  let currentPage = 1;
  // Extract the base URL without page parameter for file naming
  const urlParts = baseUrl.split("?");
  const baseUrlWithoutPage = urlParts[0];
  const outputFileName = path.join(
    outputDir,
    `${baseUrlWithoutPage
      .replace(/https?:\/\/|www\.|\.com\//g, "")
      .replace(/\//g, "_")}.json`
  );

  // Initialize the products array
  let allProducts = [];

  // Load existing data if the file exists
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

  // Start by going to the base URL
  console.log(`Starting with URL: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  await delay(3000); // Give time for the page to load

  // Pagination logic
  while (!shouldStop) {
    console.log(`Scraping page ${currentPage}...`);

    // Get all product URLs on the current page
    const productUrls = await extractProductUrls(page);

    if (productUrls.length === 0) {
      console.log(
        "No products found on this page. Moving to next page or ending if no pagination."
      );
    } else {
      // Create a new page for product details
      const productPage = await browser.newPage();

      // Process each product URL
      for (const productUrl of productUrls) {
        const productDetails = await scrapeProductDetails(
          productPage,
          productUrl
        );
        if (productDetails) {
          allProducts.push(productDetails);

          // Save after each product to prevent data loss if something fails
          fs.writeFileSync(
            outputFileName,
            JSON.stringify(allProducts, null, 2)
          );
        }
      }

      // Close the product page
      await productPage.close();
    }

    // Scroll until the "Next" button is visible
    const isNextButtonVisible = await scrollUntilVisible(
      page,
      ".pagination li:last-child a"
    );

    if (!isNextButtonVisible) {
      console.log(
        "Pagination not found or next button not visible, ending scraping."
      );
      break;
    }

    // Wait before clicking
    await delay(1000);

    // Check if this is the last page by seeing if the next button is disabled
    const isLastPage = await page.evaluate(() => {
      const nextButton = document.querySelector(".pagination li:last-child");
      return nextButton ? nextButton.classList.contains("disabled") : true;
    });

    if (isLastPage) {
      console.log("Reached the last page, ending scraping.");
      break;
    }

    // Click the next page button and wait for navigation
    console.log(`Navigating to next page`);
    try {
      await Promise.all([
        page.click(".pagination li:last-child a"),
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      ]);
    } catch (error) {
      console.error(`Error navigating to next page: ${error.message}`);
      console.log("Attempting to continue scraping...");
    }

    await delay(3000); // Wait for page load
    currentPage++;
  }

  console.log(
    `Pagination scraping finished. Scraped ${allProducts.length} products total.`
  );
  console.log(`Results saved to ${outputFileName}`);
};

const scrapeMultipleUrls = async () => {
  try {
    // Example URL for pagination testing - update this with your target URL
    const baseUrl =
      "https://www.watsons.com.tr/makyaj/goz-makyaji/far-ve-paletler/c/1013";

    // Launch browser once
    browser = await launchBrowser();

    // Process pagination for the URL
    const page = await browser.newPage();

    // Set a reasonable viewport size
    await page.setViewport({ width: 1366, height: 768 });

    // Optional: Set user agent to mimic a real browser
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    await scrapePagination(page, baseUrl);

    // Close browser
    await browser.close();
    process.exit(0);
  } catch (error) {
    console.error("Error during pagination scraping:", error);
    if (browser) await browser.close();
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on("SIGINT", async () => {
  console.log("Received SIGINT. Shutting down gracefully...");
  shouldStop = true;
  if (browser) await browser.close();
  process.exit(0);
});

scrapeMultipleUrls();
