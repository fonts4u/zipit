'use strict';
/**
 * crawler.js – Puppeteer-based website crawler.
 *
 * Uses a headless Chromium instance (@sparticuz/chromium for serverless) to:
 *   1. Render the page (handles SPAs / JS-heavy sites)
 *   2. Wait for network idle to catch lazy-loaded assets
 *   3. Extract all asset URLs from the rendered DOM
 *   4. Scroll the page to trigger lazy-load observers
 *   5. Return the final HTML and the list of discovered asset URLs
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { downloadAssets } = require('./assetDownloader');
const { rewriteHtml, rewriteCssBuffer } = require('./pathRewriter');
const { buildZip } = require('./zipBuilder');

// Use @sparticuz/chromium in production (Vercel/Lambda), local chromium in dev
let chromium;
try {
  chromium = require('@sparticuz/chromium');
} catch {
  chromium = null;
}

// ─── Browser lifecycle ───────────────────────────────────────────────────────

let _browser = null;

/**
 * Returns a shared browser instance (lazy singleton).
 * In serverless environments every invocation may get a fresh process,
 * so the singleton mainly helps within a single request lifecycle.
 */
async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;

  const launchArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--single-process',          // required for some serverless envs
    '--no-zygote',
    '--disable-software-rasterizer',
  ];

  // Use @sparticuz/chromium only in production/Vercel
  const isServerless = process.env.VERCEL || process.env.NODE_ENV === 'production';

  if (isServerless && chromium) {
    // Serverless environment — use @sparticuz/chromium
    _browser = await puppeteer.launch({
      args: [...chromium.args, ...launchArgs],
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
    });
  } else {
    // Local development — use system Chromium / Chrome
    const executablePath =
      process.env.CHROMIUM_PATH ||
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : process.platform === 'win32'
          ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
          : '/usr/bin/chromium-browser');

    _browser = await puppeteer.launch({
      args: launchArgs,
      executablePath,
      headless: 'new',
      defaultViewport: { width: 1280, height: 900 },
    });
  }

  return _browser;
}

async function closeBrowser() {
  if (_browser) {
    await _browser.close().catch(() => { });
    _browser = null;
  }
}

// ─── Asset URL extraction ────────────────────────────────────────────────────

/**
 * Extracts all asset URLs from the page using in-browser JS.
 * Covers: images, scripts, stylesheets, fonts, favicons, videos, iframes.
 *
 * @param {import('puppeteer-core').Page} page
 * @returns {Promise<string[]>}
 */
async function extractAssetUrls(page) {
  return page.evaluate(() => {
    const urls = new Set();

    // Images (src + srcset + data-src for lazy-loaders)
    document.querySelectorAll('img').forEach((el) => {
      if (el.src) urls.add(el.src);
      if (el.dataset.src) urls.add(el.dataset.src);
      if (el.srcset) {
        el.srcset.split(',').forEach((s) => {
          const url = s.trim().split(/\s+/)[0];
          if (url) urls.add(url);
        });
      }
    });

    // Scripts
    document.querySelectorAll('script[src]').forEach((el) => urls.add(el.src));

    // Stylesheets
    document.querySelectorAll('link[rel="stylesheet"]').forEach((el) => urls.add(el.href));

    // Favicons and other link[href] assets
    document.querySelectorAll('link[href]').forEach((el) => {
      const rel = (el.rel || '').toLowerCase();
      if (['icon', 'shortcut icon', 'apple-touch-icon', 'manifest'].some(r => rel.includes(r))) {
        urls.add(el.href);
      }
    });

    // Videos / audio
    document.querySelectorAll('video[src], audio[src], source[src]').forEach((el) => urls.add(el.src));

    // Inline CSS: background-image, @font-face src, etc.
    document.querySelectorAll('[style]').forEach((el) => {
      const matches = el.style.cssText.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g);
      for (const m of matches) urls.add(new URL(m[1], document.baseURI).href);
    });

    // Computed styles for all elements (heavy but thorough)
    // Skipped for performance — handled in pathRewriter via CSS parsing

    // Filter: only http(s) assets on the same domain or external
    return [...urls].filter((u) => u.startsWith('http'));
  });
}

// ─── Auto-scroll to trigger lazy loading ────────────────────────────────────

/**
 * Slowly scrolls from the top to the bottom of the page.
 * This fires IntersectionObserver callbacks used by lazy-loaders.
 *
 * @param {import('puppeteer-core').Page} page
 */
async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0); // scroll back to top
          resolve();
        }
      }, 80);
    });
  });
}

// ─── Main crawl function ─────────────────────────────────────────────────────

const PAGE_TIMEOUT_MS = 30_000; // max time for initial page load
const NETWORK_IDLE_MS = 5_000;  // wait after networkidle2 for dynamic injections

/**
 * Crawls a single URL with a headless browser.
 *
 * @param {string} url  – Fully-qualified URL (already validated)
 * @returns {Promise<{ html: string, assetUrls: string[], finalUrl: string }>}
 */
async function crawlPage(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Intercept and block non-essential requests to speed up crawling
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      // Allow everything — we need assets.  Block only tracking beacons.
      if (type === 'ping' || req.url().includes('google-analytics') || req.url().includes('doubleclick')) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Set a realistic user-agent to avoid bot-detection 403s
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    );

    // Navigate — wait for network to settle (handles SPAs)
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: PAGE_TIMEOUT_MS,
    });

    // Extra wait for any post-idle dynamic injections
    await new Promise((r) => setTimeout(r, 1_000));

    // Scroll to trigger lazy-loaded images / JS observers
    await autoScroll(page);

    // Another short pause after scroll
    await new Promise((r) => setTimeout(r, 800));

    // Extract rendered HTML and asset URLs
    const html = await page.content();
    const assetUrls = await extractAssetUrls(page);
    const finalUrl = page.url(); // may differ from input after redirects

    return { html, assetUrls, finalUrl };
  } finally {
    if (page) await page.close().catch(() => { });
  }
}

/**
 * Orchestrates the full crawl, download, rewrite, and zip pipeline.
 *
 * @param {string} url
 * @returns {Promise<{ zipPath: string, sessionId: string }>}
 */
async function crawlSite(url) {
  const sessionId = uuidv4();
  const sessionDir = path.join(os.tmpdir(), `sitezip_${sessionId}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const zipPath = path.join(sessionDir, 'archive.zip');

  // 1. Crawl the page to get HTML and list of assets
  const { html, assetUrls, finalUrl } = await crawlPage(url);
  const baseUrl = new URL(finalUrl);

  // 2. Download all assets to memory buffers
  const fileMap = await downloadAssets(assetUrls, baseUrl);

  // 3. Rewrite CSS internal links
  for (const [localPath, buffer] of fileMap.entries()) {
    if (localPath.endsWith('.css')) {
      const cssUrl = new URL(`/${localPath}`, baseUrl).href;
      const rewrittenBuffer = rewriteCssBuffer(buffer, cssUrl, baseUrl, fileMap, localPath);
      fileMap.set(localPath, rewrittenBuffer);
    }
  }

  // 4. Rewrite HTML
  const rewrittenHtml = rewriteHtml(html, baseUrl, fileMap);

  // 5. Build ZIP
  await buildZip({ html: rewrittenHtml, fileMap, pageUrl: finalUrl, destPath: zipPath });

  return { zipPath, sessionId };
}

module.exports = { crawlPage, closeBrowser, crawlSite };
