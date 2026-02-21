'use strict';
/**
 * assetDownloader.js – Downloads all discovered assets with concurrency control.
 *
 * Features:
 *  - Parallel downloads bounded by p-limit (configurable concurrency)
 *  - Per-request timeout
 *  - Skips failed assets gracefully (logs warning, does not throw)
 *  - Normalises URLs → local file paths preserving directory structure
 *  - Extracts additional asset URLs from downloaded CSS (fonts, background images)
 *  - Returns a Map<localPath, Buffer> ready for ZIP assembly
 */

const axios      = require('axios');
const path       = require('path');
const { URL }    = require('url');
const mime       = require('mime-types');
const sanitize   = require('sanitize-filename');

// p-limit is an ES module; we load it via a dynamic require shim
let pLimit;
(async () => { ({ default: pLimit } = await import('p-limit')); })();

// ─── Configuration ────────────────────────────────────────────────────────────
const CONCURRENCY          = 6;      // simultaneous downloads
const ASSET_TIMEOUT_MS     = 15_000; // per-asset request timeout
const MAX_ASSET_SIZE_BYTES = 20 * 1024 * 1024; // skip assets > 20 MB
const MAX_ASSETS           = 300;    // hard cap on total assets per site

// ─── URL → local path normalisation ─────────────────────────────────────────

/**
 * Converts an absolute asset URL into a relative local file path.
 * Examples:
 *   https://example.com/css/main.css  →  assets/css/main.css
 *   https://cdn.example.com/a.png     →  assets/cdn.example.com/a.png
 *
 * @param {string} assetUrl
 * @param {URL}    baseUrl   – Parsed URL of the crawled page
 * @returns {string}         – Relative path like "assets/..."
 */
function urlToLocalPath(assetUrl, baseUrl) {
  let parsed;
  try { parsed = new URL(assetUrl); } catch { return null; }

  // Determine sub-directory: same host → omit, different host → include host
  const hostDir = parsed.hostname === baseUrl.hostname ? '' : parsed.hostname;

  // Decode & sanitize path segments
  let pathSegments = decodeURIComponent(parsed.pathname)
    .split('/')
    .filter(Boolean)
    .map((seg) => sanitize(seg).replace(/\s+/g, '_') || '_seg');

  // If no extension, try to infer one from Content-Type (handled later)
  // For now ensure path ends with something sensible
  const lastSeg   = pathSegments[pathSegments.length - 1] || 'index';
  const hasExt    = /\.\w{1,8}$/.test(lastSeg);

  if (!hasExt) {
    pathSegments[pathSegments.length - 1] = lastSeg; // keep as-is; ext added after download
  }

  const relative = ['assets', hostDir, ...pathSegments].filter(Boolean).join('/');
  return relative;
}

// ─── CSS asset extraction ────────────────────────────────────────────────────

/**
 * Scans downloaded CSS text for additional url() references
 * (background images, @font-face src declarations, etc.)
 *
 * @param {string} cssText
 * @param {string} cssUrl    – Original URL of the CSS file (for resolving relative refs)
 * @returns {string[]}       – Absolute URLs of discovered assets
 */
function extractCssAssets(cssText, cssUrl) {
  const urls   = [];
  const regex  = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/g;
  let match;

  while ((match = regex.exec(cssText)) !== null) {
    const raw = match[1];
    if (!raw || raw.startsWith('data:')) continue;
    try {
      const abs = new URL(raw, cssUrl).href;
      if (abs.startsWith('http')) urls.push(abs);
    } catch { /* ignore */ }
  }

  return urls;
}

// ─── Single asset download ────────────────────────────────────────────────────

/**
 * Downloads a single asset and returns its buffer + detected content-type.
 * Returns null on any error (caller skips the asset).
 *
 * @param {string} url
 * @returns {Promise<{ buffer: Buffer, contentType: string } | null>}
 */
async function downloadAsset(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout:      ASSET_TIMEOUT_MS,
      maxContentLength: MAX_ASSET_SIZE_BYTES,
      maxBodyLength:    MAX_ASSET_SIZE_BYTES,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SiteArchiver/1.0)',
        'Accept':     '*/*',
      },
      // Follow up to 5 redirects
      maxRedirects: 5,
      // Validate response status
      validateStatus: (s) => s >= 200 && s < 400,
    });

    const contentType = response.headers['content-type'] || 'application/octet-stream';
    return { buffer: Buffer.from(response.data), contentType };
  } catch (err) {
    console.warn(`[assetDownloader] Skipped ${url} — ${err.message}`);
    return null;
  }
}

// ─── Main downloader ─────────────────────────────────────────────────────────

/**
 * Downloads all assets in the provided list (discovered by the crawler + DOM parser).
 * Also recursively discovers and downloads assets referenced inside CSS files.
 *
 * @param {string[]} assetUrls  – Absolute asset URLs to download
 * @param {URL}      baseUrl    – Parsed URL of the crawled page
 * @returns {Promise<Map<string, Buffer>>}  – Map of localPath → file buffer
 */
async function downloadAssets(assetUrls, baseUrl) {
  // Ensure p-limit is loaded (handles the ESM dynamic import)
  if (!pLimit) {
    ({ default: pLimit } = await import('p-limit'));
  }

  const limit          = pLimit(CONCURRENCY);
  const fileMap        = new Map();   // localPath → Buffer
  const processed      = new Set();  // avoid duplicate downloads

  // Deduplicate and cap total
  const uniqueUrls = [...new Set(assetUrls)].slice(0, MAX_ASSETS);

  /**
   * Schedules a download task for a single URL.
   * @param {string} url
   * @returns {Promise<void>}
   */
  async function scheduleDownload(url) {
    if (processed.has(url)) return;
    processed.add(url);

    const localPath = urlToLocalPath(url, baseUrl);
    if (!localPath) return;

    const result = await downloadAsset(url);
    if (!result) return;

    let { buffer, contentType } = result;

    // If the local path has no extension, try to add one from content-type
    let finalPath = localPath;
    if (!/\.\w{1,8}$/.test(localPath)) {
      const ext = mime.extension(contentType.split(';')[0].trim());
      if (ext) finalPath = `${localPath}.${ext}`;
    }

    fileMap.set(finalPath, buffer);

    // If it's a CSS file, extract any additional asset references
    if (contentType.includes('text/css') || finalPath.endsWith('.css')) {
      const cssText    = buffer.toString('utf-8');
      const cssAssets  = extractCssAssets(cssText, url);
      const newAssets  = cssAssets.filter((u) => !processed.has(u));

      if (newAssets.length > 0 && processed.size < MAX_ASSETS) {
        await Promise.all(newAssets.slice(0, MAX_ASSETS - processed.size).map((u) =>
          limit(() => scheduleDownload(u))
        ));
      }
    }
  }

  // Kick off all downloads in parallel (bounded by p-limit)
  await Promise.all(uniqueUrls.map((url) => limit(() => scheduleDownload(url))));

  console.log(`[assetDownloader] Downloaded ${fileMap.size} assets (attempted ${processed.size})`);
  return fileMap;
}

module.exports = { downloadAssets, urlToLocalPath, extractCssAssets };
