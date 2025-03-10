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
  const seenProductIds = new Set();

  if (fs.existsSync(outputFileName)) {
    try {
      const existingData = fs.readFileSync(outputFileName, "utf8");
      allProducts = JSON.parse(existingData);
      allProducts.forEach((product) => seenProductIds.add(product.productId));
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
    await page.setUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${
        Math.floor(Math.random() * 20) + 100
      }.0.0.0 Safari/537.36`
    );
    const productUrls = await extractProductUrls(page);
    console.log(`Page ${currentPage} has ${productUrls.length} products`);

    if (productUrls.length === 0) {
      console.log("No products found on this page.");
    } else {
      const productPage = await browser.newPage();
      for (const productUrl of productUrls) {
        const productDetails = await scrapeProductDetails(
          productPage,
          productUrl
        );
        if (
          productDetails &&
          productDetails.productId &&
          !seenProductIds.has(productDetails.productId)
        ) {
          seenProductIds.add(productDetails.productId);
          allProducts.push(productDetails);
          fs.writeFileSync(
            outputFileName,
            JSON.stringify(allProducts, null, 2)
          );
          console.log(
            `Progress: ${allProducts.length}/${totalProducts} unique products scraped`
          );
        } else if (productDetails && productDetails.productId) {
          console.log(
            `Skipping duplicate product with productId: ${productDetails.productId}`
          );
        }
      }
      await productPage.close();
    }

    // Check next page even if totalProducts is reached, to ensure no leftovers
    const nextButton = await page.$(".pagination .type-next:not(.disabled)");
    if (!nextButton) {
      console.log("No next button found or it’s disabled. Ending scraping.");
      break;
    }

    if (allProducts.length >= totalProducts && !nextButton) {
      console.log(
        `Reached total unique product count (${totalProducts}) and no next page. Ending scraping.`
      );
      break;
    }

    let attempts = 0;
    const maxAttempts = 3;
    let navigated = false;
    while (attempts < maxAttempts && !navigated) {
      try {
        await scrollUntilVisible(page, ".pagination .type-next");
        console.log(
          `Navigating to page ${currentPage + 1} (Attempt ${attempts + 1})`
        );
        await Promise.all([
          page.click(".pagination .type-next"),
          page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }),
        ]);
        navigated = true;
      } catch (error) {
        console.error(
          `Navigation attempt ${attempts + 1} failed: ${error.message}`
        );
        attempts++;
        await delay(5000);
      }
    }
    if (!navigated) {
      console.log(
        `Failed to navigate after ${maxAttempts} attempts. Ending scraping.`
      );
      break;
    }

    await delay(Math.random() * 2000 + 3000); // Random delay 3-5s
    currentPage++;
  }

  console.log(
    `Pagination scraping finished for ${baseUrl}. Scraped ${allProducts.length} out of ${totalProducts} products.`
  );
  console.log(`Results saved to ${outputFileName}`);
};
