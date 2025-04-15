const puppeteer = require("puppeteer");
const fs = require("fs");

async function getCredentials() {
  return new Promise((resolve) => {
    const rl = require("readline").createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question("Enter Instagram username: ", (username) => {
      rl.question("Enter Instagram password: ", (password) => {
        rl.close();
        resolve({ username, password });
      });
    });
  });
}

async function scrapeComments() {
  const { username, password } = await getCredentials();
  const browser = await puppeteer.launch({
    headless: false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: null,
  });
  let allComments = new Set(); // Track unique comments

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    await page.goto("https://www.instagram.com/accounts/login/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await page.waitForSelector('input[name="username"]', { timeout: 10000 });
    await page.type('input[name="username"]', username, { delay: 100 });
    await page.type('input[name="password"]', password, { delay: 100 });
    await page.click('button[type="submit"]');
    await new Promise((r) => setTimeout(r, 5000 + Math.random() * 2000));
    await page.goto("https://www.instagram.com/p/DIO4oIaC975/", {
      waitUntil: "networkidle2",
      timeout: 60000,
    });
    await new Promise((r) => setTimeout(r, 3000 + Math.random() * 2000));
    await page.evaluate(() => {
      const target = document.querySelector(
        "span.x193iq5w.xeuugli.x1fj9vlw.x13faqbe.x1vvkbs.xt0psk2.x1i0vuye.xvs91rp.xo1l8bm.x5n08af.x10wh9bi.x1wdrske.x8viiok.x18hxmgj"
      );
      if (target) target.scrollIntoView();
    });

    console.log(
      "Scroll manually in the browser. Type 'q' in the terminal to quit."
    );

    // Set up stdin for 'q' detection
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let shouldExit = false;
    process.stdin.on("data", (key) => {
      if (key.toString() === "q") {
        shouldExit = true;
      }
    });

    // Periodically check for new comments
    const checkComments = async () => {
      const comments = await page.evaluate(() => {
        const results = [];
        document
          .querySelectorAll(
            "div.x9f619.xjbqb8w.x78zum5.x168nmei.x13lgxp2.x5pf9jr.xo71vjh.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.xdt5ytf.xqjyukv.x1cy8zhl.x1oa3qoh.x1nhvcw1"
          )
          .forEach((node) => {
            const commentTextEl = node.querySelector(
              "span.x1lliihq.x1plvlek.xryxfnj.x1n2onr6.x1ji0vk5.x18bv5gf"
            );
            const userEl = node.parentElement.querySelector(
              "span._ap3a._aaco._aacw._aacx._aad7._aade"
            );
            if (commentTextEl && userEl) {
              const commentText = commentTextEl.textContent.trim();
              const words = commentText
                .split(/\s+/)
                .filter((w) => w.length > 0).length;
              if (words > 10)
                results.push({
                  id: userEl.textContent.trim(),
                  words,
                  comment: commentText,
                });
            }
          });
        return results;
      });

      // Identify new comments
      const newComments = comments.filter(
        (c) => !allComments.has(c.id + c.comment)
      );
      newComments.forEach((c) => allComments.add(c.id + c.comment));

      // Log number of new comments
      console.log(`New comments collected: ${newComments.length}`);

      return comments; // Return all comments for final save
    };

    // Check comments until 'q' is pressed
    while (!shouldExit) {
      await checkComments();
      await new Promise((r) => setTimeout(r, 1000)); // Check every 1 second
    }

    // Final comment collection
    const finalComments = await checkComments();
    finalComments.sort((a, b) => b.words - a.words);
    fs.writeFileSync(
      "comments.txt",
      JSON.stringify(
        finalComments.map((c) => ({
          id: c.id,
          words: c.words,
          comment: c.comment,
        })),
        null,
        2
      ),
      "utf8"
    );
    console.log(`Total comments saved: ${finalComments.length}`);

    if (global.gc) global.gc();
  } catch (error) {
    console.error("Error:", error);
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    await browser.close();
  }
}

process.on("uncaughtException", (error) =>
  console.error("Uncaught Exception:", error)
);
process.on("unhandledRejection", (reason, p) =>
  console.error("Unhandled Rejection at:", p, "reason:", reason)
);

scrapeComments();
