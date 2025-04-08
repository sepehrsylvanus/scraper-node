// Scrape product details
const scrapeProductDetails = async (page, url, retries = 3) => {
  logProgress("PRODUCT_SCRAPING", `Navigating to product URL: ${url}`);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await page.setUserAgent(getRandomUserAgent());
      await page.setExtraHTTPHeaders({
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        Referer: "https://www.dermokozmetika.com.tr/",
        "Upgrade-Insecure-Requests": "1",
      });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });

      // Wait for and click the modal close button if it exists
      try {
        await page.waitForSelector("#closeModalButton", { timeout: 5000 });
        await page.click("#closeModalButton");
        logProgress("PRODUCT_SCRAPING", "Closed modal popup");
        await delay(1000);
      } catch (e) {
        logProgress(
          "PRODUCT_SCRAPING",
          "No modal found or failed to close: " + e.message
        );
      }

      // Wait for the product title to ensure page is fully loaded
      await page.waitForSelector("#product-title", { timeout: 30000 });
      await simulateHumanBehavior(page);

      const productData = await page.evaluate(() => {
        // Extract title
        const titleElement = document.querySelector("#product-title");
        const title = titleElement ? titleElement.textContent.trim() : "";

        // Extract brand from href and capitalize first letter
        const brandElement = document.querySelector(
          "#product-right .w-100 a[href^='/']"
        );
        let brand = "";
        if (brandElement) {
          const href = brandElement.getAttribute("href").replace("/", "");
          brand = href.charAt(0).toUpperCase() + href.slice(1);
        }

        // Extract price
        const priceElement = document.querySelector(
          ".product-current-price .product-price"
        );
        let price = null;
        if (priceElement) {
          const priceText = priceElement.textContent
            .trim()
            .replace(/[^0-9,]/g, "")
            .replace(",", ".");
          price = parseFloat(priceText);
        }

        // Extract images from product-images-gallery
        const imageElements = document.querySelectorAll(
          ".product-images-gallery .image-inner img"
        );
        const images = Array.from(imageElements)
          .map((img) => img.getAttribute("src") || img.getAttribute("data-src"))
          .filter((src) => src && !src.includes("placeholder"));

        // Extract rating
        const ratingElement = document.querySelector("#ortalamaPuan");
        const rating = ratingElement
          ? parseFloat(ratingElement.textContent.trim())
          : null;

        // Extract description from #product-fullbody
        const descriptionElement = document.querySelector("#product-fullbody");
        let description = "";
        if (descriptionElement) {
          description = descriptionElement.innerHTML.trim();
        }

        return { title, brand, price, images, rating, description };
      });

      return {
        url,
        title: productData.title || "",
        brand: productData.brand || "",
        price:
          productData.price !== null
            ? parseFloat(productData.price.toFixed(2))
            : null,
        currency: "TL",
        images: productData.images.length ? productData.images.join(";") : "",
        rating: productData.rating || null,
        description: productData.description || "",
      };
    } catch (error) {
      logProgress(
        "PRODUCT_SCRAPING",
        `Attempt ${attempt + 1} failed: ${error.message}`
      );
      if (attempt === retries - 1) {
        return {
          url,
          title: "",
          brand: "",
          price: null,
          currency: "TL",
          images: "",
          rating: null,
          description: "",
          reviewCount: 0,
          discount: "",
          features: [],
        };
      }
      await delay(5000);
    }
  }
};
