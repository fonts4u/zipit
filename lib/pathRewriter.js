'use strict';
/**
 * pathRewriter.js – Rewrites all absolute asset URLs in HTML and CSS to
 * local relative paths so the archived site works offline.
 *
 * Handles:
 *   - <script src>, <link href>, <img src>, <source src/srcset>
 *   - CSS url() references (background, font-face, etc.)
 *   - Inline style attributes
 *   - data-src / data-lazy-src lazy-loader attributes
 *   - <a href> same-origin links rewritten to index.html
 */

const cheerio  = require('cheerio');
const { URL }  = require('url');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Converts an absolute URL to the equivalent local path used in fileMap.
 * Must mirror the logic in assetDownloader.urlToLocalPath exactly.
 *
 * @param {string} assetUrl
 * @param {URL}    baseUrl
 * @param {Map}    fileMap   – to verify the path actually exists after download
 * @returns {string|null}
 */
function resolveLocalPath(assetUrl, baseUrl, fileMap) {
  let parsed;
  try { parsed = new URL(assetUrl); } catch { return null; }

  const hostDir = parsed.hostname === baseUrl.hostname ? '' : parsed.hostname;

  const segments = decodeURIComponent(parsed.pathname)
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/\s+/g, '_'));

  // Try exact path first
  const candidates = [
    ['assets', hostDir, ...segments].filter(Boolean).join('/'),
  ];

  // Also try common extension variants
  const last = segments[segments.length - 1] || '';
  if (!/\.\w{1,8}$/.test(last)) {
    ['css', 'js', 'png', 'jpg', 'svg', 'woff2', 'woff', 'ttf'].forEach((ext) => {
      const segsWithExt = [...segments];
      segsWithExt[segsWithExt.length - 1] = `${last}.${ext}`;
      candidates.push(['assets', hostDir, ...segsWithExt].filter(Boolean).join('/'));
    });
  }

  return candidates.find((c) => fileMap.has(c)) || candidates[0];
}

// ─── CSS url() rewriter ───────────────────────────────────────────────────────

/**
 * Rewrites url() references inside a CSS string.
 *
 * @param {string} cssText
 * @param {string} cssUrl       – Original URL of the CSS file
 * @param {URL}    baseUrl
 * @param {Map}    fileMap
 * @param {string} cssLocalPath – Local path of this CSS file (for relative depth)
 * @returns {string}
 */
function rewriteCss(cssText, cssUrl, baseUrl, fileMap, cssLocalPath) {
  const cssDepth    = cssLocalPath.split('/').length - 1;
  const depthPrefix = cssDepth > 0 ? '../'.repeat(cssDepth) : './';

  return cssText.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (match, quote, ref) => {
    if (ref.startsWith('data:') || ref.startsWith('#')) return match;

    let absUrl;
    try { absUrl = new URL(ref, cssUrl).href; } catch { return match; }

    const localPath = resolveLocalPath(absUrl, baseUrl, fileMap);
    if (!localPath) return match;

    // Calculate relative path from CSS file location to asset
    const relative  = `${depthPrefix}${localPath}`;
    return `url(${quote}${relative}${quote})`;
  });
}

// ─── HTML rewriter ────────────────────────────────────────────────────────────

/**
 * Rewrites all asset references in HTML to relative local paths.
 *
 * @param {string} html
 * @param {URL}    baseUrl
 * @param {Map}    fileMap   – localPath → Buffer (from downloader)
 * @returns {string}         – Modified HTML with local paths
 */
function rewriteHtml(html, baseUrl, fileMap) {
  const $ = cheerio.load(html, { decodeEntities: false });

  function toLocal(attrValue) {
    if (!attrValue) return attrValue;
    // Skip data URIs, anchors, mailto, etc.
    if (/^(data:|#|mailto:|tel:|javascript:)/i.test(attrValue)) return attrValue;

    let absUrl;
    try {
      absUrl = new URL(attrValue, baseUrl.href).href;
    } catch {
      return attrValue;
    }

    if (!absUrl.startsWith('http')) return attrValue;

    const localPath = resolveLocalPath(absUrl, baseUrl, fileMap);
    return localPath ? localPath : attrValue;
  }

  // ── Scripts ──
  $('script[src]').each((_, el) => {
    const newSrc = toLocal($(el).attr('src'));
    if (newSrc) $(el).attr('src', newSrc);
  });

  // ── Stylesheets ──
  $('link[rel="stylesheet"]').each((_, el) => {
    const newHref = toLocal($(el).attr('href'));
    if (newHref) $(el).attr('href', newHref);
  });

  // ── Images ──
  $('img').each((_, el) => {
    const $el = $(el);
    const src = toLocal($el.attr('src'));
    if (src) $el.attr('src', src);

    // data-src (lazy loaders)
    const dataSrc = toLocal($el.attr('data-src'));
    if (dataSrc) $el.attr('data-src', dataSrc);
    if (dataSrc) $el.attr('src', dataSrc); // ensure it loads offline too

    // srcset
    const srcset = $el.attr('srcset');
    if (srcset) {
      const rewritten = srcset.split(',').map((s) => {
        const parts = s.trim().split(/\s+/);
        const url   = toLocal(parts[0]);
        return [url, ...parts.slice(1)].join(' ');
      }).join(', ');
      $el.attr('srcset', rewritten);
    }
  });

  // ── Video / audio sources ──
  $('video[src], audio[src], source[src]').each((_, el) => {
    const newSrc = toLocal($(el).attr('src'));
    if (newSrc) $(el).attr('src', newSrc);
  });

  // ── Favicons and other link[href] ──
  $('link[href]:not([rel="stylesheet"])').each((_, el) => {
    const rel = (($(el).attr('rel')) || '').toLowerCase();
    if (rel.includes('icon') || rel.includes('apple-touch') || rel.includes('manifest')) {
      const newHref = toLocal($(el).attr('href'));
      if (newHref) $(el).attr('href', newHref);
    }
  });

  // ── Inline styles ──
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const rewritten = style.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (match, q, ref) => {
      if (ref.startsWith('data:')) return match;
      let abs;
      try { abs = new URL(ref, baseUrl.href).href; } catch { return match; }
      const local = resolveLocalPath(abs, baseUrl, fileMap);
      return local ? `url(${q}${local}${q})` : match;
    });
    if (rewritten !== style) $(el).attr('style', rewritten);
  });

  // ── Same-origin <a href> links → point to index.html (best-effort offline nav) ──
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return;
    try {
      const target = new URL(href, baseUrl.href);
      if (target.hostname === baseUrl.hostname) {
        // Rewrite to a local html file; simple approach: just use index.html
        $(el).attr('href', 'index.html');
      }
    } catch { /* leave as-is */ }
  });

  // Remove canonical and base tags that would break offline usage
  $('base').remove();
  $('link[rel="canonical"]').remove();

  return $.html();
}

/**
 * Rewrites a downloaded CSS file's url() references.
 *
 * @param {Buffer} cssBuffer
 * @param {string} cssUrl
 * @param {URL}    baseUrl
 * @param {Map}    fileMap
 * @param {string} cssLocalPath
 * @returns {Buffer}
 */
function rewriteCssBuffer(cssBuffer, cssUrl, baseUrl, fileMap, cssLocalPath) {
  const cssText    = cssBuffer.toString('utf-8');
  const rewritten  = rewriteCss(cssText, cssUrl, baseUrl, fileMap, cssLocalPath);
  return Buffer.from(rewritten, 'utf-8');
}

module.exports = { rewriteHtml, rewriteCssBuffer, rewriteCss };
