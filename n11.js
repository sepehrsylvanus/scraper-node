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

const extractProductUrls = async (page) => {
  return await page.evaluate(() => {
    const productElements = document.querySelectorAll(".columnContent");
    return Array.from(productElements)
      .map((element) => {
        const linkElement = element.querySelector(".pro a[href]");
        return linkElement ? linkElement.getAttribute("href") : null;
      })
      .filter((url) => url !== null);
  });
};

const scrapePageByPage = async (page, baseUrl, processedUrls = new Set()) => {
  console.log(`Starting page-by-page scrape for: ${baseUrl}`);
  await page.goto(baseUrl, { waitUntil: "networkidle2" });
  await delay(3000);

  const totalProducts = await page.evaluate(() => {
    const resultElement = document.querySelector(
      ".listOptionHolder .resultText strong"
    );
    if (!resultElement) return 0;
    const text = resultElement.textContent.trim();
    const cleanedNumber = text.replace(/[^0-9-]/g, "");
    return cleanedNumber ? parseInt(cleanedNumber, 10) : 0;
  });
  console.log(`Total products expected: ${totalProducts || "Unknown"}`);

  let allProductUrls = new Set();
  let currentPage = 1;
  const maxRetriesPerPage = 3; // Maximum retries per page if products are missing

  while (
    !shouldStop &&
    (totalProducts === 0 ||
      allProductUrls.size + processedUrls.size < totalProducts)
  ) {
    console.log(`Scraping page ${currentPage}...`);
    let retries = 0;
    let currentUrls = [];

    while (retries < maxRetriesPerPage) {
      try {
        currentUrls = await extractProductUrls(page);
        const expectedPerPage = Math.min(
          28,
          totalProducts - allProductUrls.size - processedUrls.size
        );
        if (currentUrls.length >= expectedPerPage || currentUrls.length === 0) {
          console.log(
            `Found ${currentUrls.length} products on page ${currentPage}, proceeding...`
          );
          break;
        }
        console.log(
          `Only ${
            currentUrls.length
          }/${expectedPerPage} products found on page ${currentPage}. Retrying (${
            retries + 1
          }/${maxRetriesPerPage})...`
        );
        retries++;
        await page.reload({ waitUntil: "networkidle2" });
        await delay(5000);
      } catch (error) {
        console.error(
          `Error extracting URLs on page ${currentPage}, retry ${retries + 1}:`,
          error.message
        );
        retries++;
        if (retries === maxRetriesPerPage) {
          console.log(
            `Max retries reached for page ${currentPage}. Moving forward with collected URLs.`
          );
          break;
        }
        await delay(5000);
      }
    }

    currentUrls.forEach((url) => {
      const absoluteUrl = url.startsWith("http")
        ? url
        : `${baseUrl.split("/").slice(0, 3).join("/")}${url}`;
      if (!processedUrls.has(absoluteUrl)) {
        allProductUrls.add(absoluteUrl);
      }
    });
    console.log(
      `Collected ${allProductUrls.size}/${
        totalProducts || "unknown"
      } unique products on page ${currentPage}`
    );

    const hasNextPage = await page.evaluate(() => {
      const nextButton = document.querySelector(
        ".pagination a.next:not(.disabled)"
      );
      return !!nextButton;
    });

    if (!hasNextPage) {
      console.log(`No next page available after page ${currentPage}.`);
      break;
    }

    const nextPage = currentPage + 1;
    const nextUrl = `${baseUrl.split("?")[0]}?pg=${nextPage}`;
    console.log(`Navigating to next page: ${nextUrl}`);
    try {
      await page.goto(nextUrl, { waitUntil: "networkidle2", timeout: 30000 });
      await delay(3000);
      currentPage = nextPage;
    } catch (error) {
      console.log(`Failed to navigate to ${nextUrl}:`, error.message);
      break;
    }
  }

  const productUrls = Array.from(allProductUrls);
  console.log(
    `Collected ${productUrls.length} new unique product URLs in this pass.`
  );
  return { productUrls, totalProducts };
};
