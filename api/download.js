/**
 * api/download.js
 * Vercel serverless function - main API endpoint.
 *
 * POST /api/download
 * Body: { url: string }
 * Response: ZIP file stream (application/zip)
 *
 * Error responses: JSON with { error: string }
 *
 * Pipeline:
 * 1. Validate & sanitize URL (SSRF protection)
 * 2. Rate limit check
 * 3. DNS validation of resolved IP
 * 4. Crawl site (render, extract, download, rewrite)
 * 5. Stream ZIP to client
 * 6. Schedule temp file cleanup
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { validateUrl } = require('../lib/security');
const { rateLimitMiddleware } = require('../lib/rateLimiter');
const { crawlSite } = require('../lib/crawler');
const { cleanupDir } = require('../lib/zipBuilder');
const logger = require('../lib/logger');

// Max total execution time for the crawl (Vercel Pro: 60s, Hobby: 10s)
const CRAWL_TIMEOUT_MS = parseInt(process.env.CRAWL_TIMEOUT_MS || '55000', 10);

/**
 * Wraps an Express-style middleware into a Promise.
 * Allows us to await middleware in serverless functions.
 */
function runMiddleware(req, res, fn) {
  return new Promise((resolve, reject) => {
    fn(req, res, (result) => {
      if (result instanceof Error) return reject(result);
      return resolve(result);
    });
  });
}

/**
 * Sends a standardized JSON error response.
 */
function sendError(res, statusCode, message, details = null) {
  logger.warn('Request error', { statusCode, message, details });
  return res.status(statusCode).json({
    error: message,
    ...(details && process.env.NODE_ENV !== 'production' ? { details } : {}),
  });
}

/**
 * Main serverless handler.
 */
module.exports = async function handler(req, res) {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  logger.info('Incoming request', { requestId, method: req.method, url: req.url });

  // Only accept POST
  if (req.method !== 'POST') {
    return sendError(res, 405, 'Method not allowed. Use POST.');
  }

  // Apply rate limiting
  try {
    await runMiddleware(req, res, rateLimitMiddleware);
  } catch (err) {
    // rateLimitMiddleware already sent the response
    return;
  }

  // Check if response was already sent (rate limit hit)
  if (res.headersSent) return;

  // Parse request body
  const { url: rawUrl } = req.body || {};

  if (!rawUrl) {
    return sendError(res, 400, 'Missing required field: url');
  }

  // Step 1: Validate URL structure + SSRF check
  let validationResult;
  try {
    validationResult = await validateUrl(rawUrl);
  } catch (err) {
    return sendError(res, 500, 'Failed to validate URL.');
  }

  if (!validationResult || !validationResult.valid) {
    return sendError(res, 400, (validationResult && validationResult.error) || 'Invalid URL provided.');
  }

  const targetUrl = validationResult.url;

  logger.info('Starting crawl', { requestId, url: targetUrl.href });

  // Step 3: Crawl with timeout protection
  let zipPath, sessionId;
  try {
    const result = await Promise.race([
      crawlSite(targetUrl.href),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Crawl exceeded timeout of ${CRAWL_TIMEOUT_MS}ms`)),
          CRAWL_TIMEOUT_MS
        )
      ),
    ]);
    zipPath = result.zipPath;
    sessionId = result.sessionId;
  } catch (err) {
    logger.error('Crawl failed', { requestId, error: err.message, stack: err.stack });

    if (err.message.includes('timeout')) {
      return sendError(res, 504, 'Site took too long to crawl. Try a simpler page or reduce crawl depth.');
    }
    return sendError(res, 500, 'Failed to crawl the website. It may be inaccessible or blocking scrapers.');
  }

  // Step 4: Verify ZIP was created
  if (!zipPath || !fs.existsSync(zipPath)) {
    return sendError(res, 500, 'ZIP generation failed. No output file found.');
  }

  const zipStats = fs.statSync(zipPath);
  const hostname = targetUrl.hostname.replace(/^www\./, '');
  const filename = `${hostname}_archive.zip`;

  logger.info('Sending ZIP', { requestId, filename, sizeBytes: zipStats.size });

  // Step 5: Stream ZIP to client
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', zipStats.size);
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('Cache-Control', 'no-store');

  try {
    const stream = fs.createReadStream(zipPath);
    await new Promise((resolve, reject) => {
      stream.on('error', (err) => {
        logger.error('Stream error', { requestId, error: err.message });
        if (!res.headersSent) {
          res.status(500).end();
        }
        reject(err);
      });
      res.on('finish', resolve);
      res.on('close', resolve);
      stream.pipe(res);
    });
    logger.info('ZIP sent successfully', { requestId });
  } catch (err) {
    logger.error('Error streaming ZIP', { requestId, error: err.message });
  } finally {
    // Blocking cleanup: guarantees Vercel doesn't freeze the filesystem with temp files
    const sessionDir = path.dirname(zipPath);
    try {
      await cleanupDir(sessionDir);
    } catch (e) {
      logger.warn('Cleanup failed', { sessionId, error: e.message });
    }
  }
};
