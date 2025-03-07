const advancedInfiniteScroll = async (page) => {
  console.log("Starting advanced infinite scroll...");

  // Get total product count
  const totalExpectedProducts = await page.evaluate(() => {
    const totalElement = document.querySelector(".product-list_total__TvMCW");
    if (totalElement) {
      const match = totalElement.textContent.match(/\d+/);
      return match ? parseInt(match[0], 10) : 500;
    }
    return 500; // Default fallback
  });

  console.log(`Expected total products: ${totalExpectedProducts}`);

  let lastProductCount = 0;
  let noChangeCount = 0;
  let pageCounter = 1; // Track virtual pages
  const maxNoChangeRetries = 3;

  const slowScroll = async () => {
    await page.evaluate(async () => {
      return new Promise((resolve) => {
        let scrollStep = 100;
        let scrollInterval = setInterval(() => {
          window.scrollBy(0, scrollStep);
          if (
            window.innerHeight + window.scrollY >=
            document.body.scrollHeight
          ) {
            clearInterval(scrollInterval);
            resolve();
          }
        }, 200); // Scroll every 200ms
      });
    });
    await delay(2000);
  };

  while (noChangeCount < maxNoChangeRetries) {
    await slowScroll();

    // Handle stuck scenario after page 13
    if (pageCounter >= 13) {
      console.log("Reached page 13, adding extra delay...");
      await delay(5000); // Wait longer to ensure all products are loaded
    }

    // Try clicking "Show More" button if present
    const hasMoreButton = await page.evaluate(() => {
      const showMoreBtn = document.querySelector(
        ".product-list_showMoreButton__eS2_Z"
      );
      if (showMoreBtn && showMoreBtn.offsetParent !== null) {
        showMoreBtn.click();
        return true;
      }
      return false;
    });

    if (hasMoreButton) {
      console.log("Clicked 'Show More' button");
      await delay(4000);
    }

    // Count loaded products
    const currentProductCount = await page.evaluate(() => {
      return document.querySelectorAll(".listProductItem").length;
    });

    console.log(
      `Found ${currentProductCount} / ${totalExpectedProducts} products`
    );

    // Handle being stuck
    if (currentProductCount === lastProductCount) {
      noChangeCount++;
      console.log(
        `No new products loaded. Retry ${noChangeCount}/${maxNoChangeRetries}`
      );

      if (noChangeCount >= maxNoChangeRetries) {
        console.log("Page might be stuck. Refreshing...");
        await page.reload({ waitUntil: "networkidle2" });
        await delay(5000);
        noChangeCount = 0; // Reset retry count after refresh
      } else {
        await page.evaluate(() => {
          window.scrollBy(0, -200);
        });
        await delay(500);
        await page.evaluate(() => {
          window.scrollBy(0, 200);
        });
        await delay(2000);
      }
    } else {
      noChangeCount = 0;
      pageCounter++; // Increase page counter if new products load
    }

    lastProductCount = currentProductCount;

    if (currentProductCount >= totalExpectedProducts) {
      console.log("Found all expected products!");
      break;
    }
  }

  const finalProductCount = await page.evaluate(() => {
    return document.querySelectorAll(".listProductItem").length;
  });

  console.log(
    `Finished scrolling. Found ${finalProductCount} products in total.`
  );
  return true;
};

// Helper function to add delay
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
