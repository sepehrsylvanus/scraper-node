const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const readline = require("readline");
const fs = require("fs").promises;

function validateProductId(productId) {
  // Validate product ID format, e.g., HBC followed by alphanumeric characters
  const productIdPattern = /^HBC[A-Z0-9]+$/;
  return productIdPattern.test(productId);
}

async function scrollUntilProductFound(page, targetProductId, totalProducts) {
  console.log(
    `[DEBUG] Starting scroll to find product with ID: "${targetProductId}"`
  );
  let lastProductCount = 0;
  let matchingProduct = null;
  const maxProductsToCheck = 500;
  let scrollPosition = 0;

  while (
    !matchingProduct &&
    !page.isClosed() &&
    (totalProducts === null || lastProductCount < totalProducts) &&
    (totalProducts === null || lastProductCount < maxProductsToCheck)
  ) {
    const products = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll("article.productCard-VQtVQDmG__hermiOJr6T")
      ).map((product, index) => {
        const linkElement = product.querySelector("a");
        const link = linkElement ? linkElement.getAttribute("href") : null;
        const fullLink = link ? `https://www.hepsiburada.com${link}` : null;
        const idMatch = link ? link.match(/p[m]?-HB(CV)?[A-Z0-9]+/) : null;
        const productId = idMatch ? idMatch[0].replace(/p[m]?-/, "") : null;
        return {
          link: fullLink,
          productId: productId,
          position: index + 1,
        };
      });
    });

    lastProductCount = products.length;
    console.log(`[DEBUG] Scanned ${lastProductCount} products:`);
    products.forEach((product) => {
      console.log(
        `[DEBUG] Position ${product.position}: URL="${product.link}", ID="${product.productId}"`
      );
    });

    matchingProduct = products.find(
      (product) => product.productId === targetProductId
    );

    if (matchingProduct) {
      console.log(
        `[INFO] Product found at position ${matchingProduct.position} after loading ${lastProductCount} products`
      );
      return matchingProduct;
    }

    if (totalProducts !== null && lastProductCount >= totalProducts) {
      console.log(
        `[INFO] Loaded all ${totalProducts} products, but target not found`
      );
      return null;
    }

    if (totalProducts !== null && lastProductCount >= maxProductsToCheck) {
      console.log(
        `[INFO] Reached limit of ${maxProductsToCheck} products, target not found`
      );
      return null;
    }

    const documentHeight = await page.evaluate(
      () => document.body.scrollHeight
    );
    if (totalProducts === null && scrollPosition >= documentHeight) {
      console.log(
        `[INFO] Reached bottom of page with ${lastProductCount} products, total unknown, target not found`
      );
      return null;
    }

    console.log(
      `[DEBUG] Loaded ${lastProductCount}/${
        totalProducts || "unknown"
      } products, scrolling...`
    );
    await page.evaluate(() => window.scrollBy(0, 500)).catch(() => {});
    scrollPosition += 500;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  return null;
}

async function searchAndAddToCart(page, keyword, targetProductId) {
  try {
    if (!validateProductId(targetProductId)) {
      console.error(`[ERROR] Invalid product ID format: "${targetProductId}"`);
      return {
        keyword,
        targetProductId,
        status: "Invalid product ID",
        position: null,
        totalProducts: null,
        addedToCart: false,
        error:
          "Product ID does not match expected format (HBC followed by alphanumeric characters)",
      };
    }
    console.log(
      `\n=== Searching "${keyword}" for product ID "${targetProductId}" ===`
    );

    await page.goto("https://www.hepsiburada.com/", {
      waitUntil: "networkidle2",
      timeout: 90000,
    });

    // Click the initial search bar to open the modal
    await page.waitForSelector(".initialComponent-jWu4fqeOfmZhku5aNxLE", {
      timeout: 60000,
    });
    await page.click(".initialComponent-jWu4fqeOfmZhku5aNxLE");
    console.log("[DEBUG] Clicked initial search bar to open modal");

    // Wait for the modal's search input and type the keyword
    await page.waitForSelector(".searchBarContent-UfviL0lUukyp5yKZTi4k", {
      timeout: 60000,
    });
    await page.type(".searchBarContent-UfviL0lUukyp5yKZTi4k", keyword);
    console.log("[DEBUG] Typed keyword into modal search input");

    // Press Enter to search
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 }),
      page.keyboard.press("Enter"),
    ]);

    await page.waitForSelector("article.productCard-VQtVQDmG__hermiOJr6T", {
      timeout: 60000,
    });

    const totalProducts = await page
      .evaluate(() => {
        const totalElement = document.querySelector(
          ".searchResultSummary span"
        );
        return totalElement
          ? parseInt(totalElement.textContent.match(/(\d+)/)?.[0] || "0", 10)
          : null;
      })
      .catch(() => null);
    console.log(`Total products found: ${totalProducts || "Unknown"}`);

    const matchingProduct = await scrollUntilProductFound(
      page,
      targetProductId,
      totalProducts
    );

    if (!matchingProduct) {
      console.log(
        `❌ Product with ID "${targetProductId}" not found for "${keyword}"`
      );
      return {
        keyword,
        targetProductId,
        status: "Not found",
        position: null,
        totalProducts: totalProducts,
        addedToCart: false,
      };
    }

    console.log(
      `✅ Found at position ${matchingProduct.position} out of ${
        totalProducts || "unknown"
      } products`
    );

    // Click the product link directly on the search page
    await page.evaluate((targetProductId) => {
      const linkElement = Array.from(
        document.querySelectorAll("article.productCard-VQtVQDmG__hermiOJr6T a")
      ).find((a) => {
        const idMatch = a.getAttribute("href")?.match(/p[m]?-HB(CV)?[A-Z0-9]+/);
        return idMatch && idMatch[0].replace(/p[m]?-/, "") === targetProductId;
      });
      if (linkElement) linkElement.click();
    }, targetProductId);

    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 90000 });

    // Updated "Add to Cart" section to match the provided HTML
    const addToCartButtonSelector = 'button.sf-Axjyr:contains("Sepete ekle")';
    await page.waitForFunction(
      (selector) => {
        return !!document.querySelector(selector);
      },
      { timeout: 30000 },
      addToCartButtonSelector
    );
    await page.click(addToCartButtonSelector);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log("✅ Added to cart successfully");

    return {
      keyword,
      targetProductId,
      status: "Success",
      position: matchingProduct.position,
      totalProducts: totalProducts,
      addedToCart: true,
    };
  } catch (error) {
    console.error(`❌ Error with "${keyword}":`, error.message);
    return {
      keyword,
      targetProductId,
      status: "Error",
      position: null,
      totalProducts: null,
      addedToCart: false,
      error: error.message,
    };
  }
}

async function collectInputSets() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const questionAsync = (query) =>
    new Promise((resolve) => rl.question(query, resolve));

  const inputSets = [];
  let continueAdding = true;

  while (continueAdding) {
    console.log("\n--- New Product Set ---");
    const targetProductId = await questionAsync(
      "Enter product ID (e.g., HBC00007Z0AOA): "
    );
    console.log("Enter keywords (one per line, press Enter twice to finish):");
    const keywords = [];
    while (true) {
      const line = await questionAsync("");
      if (line.trim() === "") break;
      keywords.push(line.trim());
    }

    if (targetProductId.trim() && keywords.length > 0) {
      if (validateProductId(targetProductId)) {
        inputSets.push({ targetProductId, keywords });
      } else {
        console.log(
          `Skipping this set: Invalid product ID "${targetProductId}".`
        );
      }
    } else {
      console.log("Skipping this set: Missing product ID or keywords.");
    }

    const addMore = await questionAsync("Add another product set? (y/n): ");
    continueAdding = addMore.toLowerCase() === "y";
  }

  rl.close();
  return inputSets;
}

async function main() {
  console.log("=== Hepsiburada Search and Clicker ===");

  const inputSets = await collectInputSets();
  if (!inputSets.length) {
    console.log("No valid input sets provided. Exiting.");
    return;
  }

  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    protocolTimeout: 120000,
    timeout: 90000,
  });

  const report = {
    timestamp: new Date().toISOString(),
    iterations: [],
  };

  try {
    for (let iteration = 1; iteration <= 30; iteration++) {
      console.log(`\n=== Starting Iteration ${iteration} of 30 ===`);
      const iterationResults = [];

      for (const set of inputSets) {
        console.log(`\nProcessing product ID: "${set.targetProductId}"`);
        const keywordResults = [];

        for (const keyword of set.keywords) {
          const page = await browser.newPage();
          await page.setDefaultNavigationTimeout(90000);
          await page.setDefaultTimeout(60000);
          page.on("console", (msg) => console.log("Browser:", msg.text()));

          const result = await searchAndAddToCart(
            page,
            keyword,
            set.targetProductId
          );
          keywordResults.push(result);
          await page.close();
        }

        iterationResults.push({
          productId: set.targetProductId,
          keywords: keywordResults,
        });
      }

      report.iterations.push({
        iteration: iteration,
        results: iterationResults,
      });

      console.log(`\n=== Completed Iteration ${iteration} ===`);
    }

    await browser.close();
    console.log("\n=== All Iterations Completed ===");

    console.log("\nSummary:");
    report.iterations.forEach((iter) => {
      console.log(`\nIteration ${iter.iteration}:`);
      iter.results.forEach((set) => {
        console.log(`  Product ID: ${set.productId}`);
        set.keywords.forEach((kw) => {
          console.log(
            `    "${kw.keyword}": ${
              kw.status === "Success"
                ? `Found at ${kw.position}/${kw.totalProducts}, Added to cart`
                : `${kw.status}${kw.error ? ` - ${kw.error}` : ""}`
            }`
          );
        });
      });
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `hepsiburada_clicks_${timestamp}.json`;
    await fs.writeFile(filename, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to ${filename}`);
  } catch (error) {
    console.error("Fatal error:", error);
    await browser.close();

    if (report.iterations.length) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `hepsiburada_clicks_partial_${timestamp}.json`;
      await fs.writeFile(filename, JSON.stringify(report, null, 2));
      console.log(`Partial report saved to ${filename}`);
    }
  }
}

main().catch((error) => {
  console.error("Main error:", error);
  process.exit(1);
});
