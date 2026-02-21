'use strict';
/**
 * security.js – SSRF protection, URL validation, and in-memory rate limiting.
 *
 * All user-supplied URLs are funnelled through validateUrl() before any
 * network call is made by the crawler.  Rate limiting is keyed on the
 * client IP; swap the Map for Redis/Upstash in a multi-instance deployment.
 */

const { URL } = require('url');
const dns = require('dns').promises;

// ─── SSRF: blocked CIDR ranges ──────────────────────────────────────────────
const BLOCKED_CIDRS = [
  { base: '10.0.0.0',     bits: 8  },  // RFC-1918 class-A private
  { base: '172.16.0.0',   bits: 12 },  // RFC-1918 class-B private
  { base: '192.168.0.0',  bits: 16 },  // RFC-1918 class-C private
  { base: '127.0.0.0',    bits: 8  },  // Loopback
  { base: '169.254.0.0',  bits: 16 },  // Link-local / AWS IMDS
  { base: '100.64.0.0',   bits: 10 },  // Carrier-grade NAT (RFC-6598)
  { base: '0.0.0.0',      bits: 8  },  // Reserved
  { base: '192.0.2.0',    bits: 24 },  // TEST-NET-1 (RFC-5737)
  { base: '198.51.100.0', bits: 24 },  // TEST-NET-2
  { base: '203.0.113.0',  bits: 24 },  // TEST-NET-3
  { base: '224.0.0.0',    bits: 4  },  // Multicast
  { base: '240.0.0.0',    bits: 4  },  // Reserved (future)
];

function ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
}

function ipInCidr(ip, { base, bits }) {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(base) & mask);
}

function isBlockedIp(ip) {
  if (!ip) return true;
  // IPv6 loopback and unique-local addresses
  if (ip === '::1' || /^(fe80|fc|fd)/i.test(ip)) return true;
  // IPv4 CIDR check
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return BLOCKED_CIDRS.some((c) => { try { return ipInCidr(ip, c); } catch { return false; } });
  }
  return false;
}

// ─── URL Validation ──────────────────────────────────────────────────────────
/**
 * Validates a raw URL string.
 * - Checks protocol (http/https only)
 * - Checks for banned internal hostnames
 * - Resolves DNS and verifies no record maps to a private IP
 *
 * @param {string} rawUrl
 * @returns {Promise<{ valid: boolean, url?: URL, error?: string }>}
 */
async function validateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'URL is required.' };
  }

  const trimmed = rawUrl.trim();

  if (!/^https?:\/\//i.test(trimmed)) {
    return { valid: false, error: 'Only http:// and https:// URLs are supported.' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Invalid URL — could not be parsed.' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { valid: false, error: 'Only HTTP/HTTPS protocols are allowed.' };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets

  // Fast-path block for well-known internal names
  if (['localhost', '0.0.0.0', '::1'].includes(hostname)) {
    return { valid: false, error: 'Access to internal hosts is not permitted.' };
  }

  // If the hostname is already a raw IPv4 address, check it immediately
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) && isBlockedIp(hostname)) {
    return { valid: false, error: 'Private or reserved IP addresses are not allowed.' };
  }

  // DNS-based SSRF check — resolve A records and verify each
  try {
    let addresses;
    try {
      addresses = await dns.resolve4(hostname);
    } catch {
      // Fallback: try any record type (CNAME, AAAA, etc.)
      const fallback = await dns.resolve(hostname);
      addresses = Array.isArray(fallback) ? fallback : [fallback];
    }

    for (const addr of addresses) {
      if (isBlockedIp(addr)) {
        return { valid: false, error: `Hostname resolves to blocked IP: ${addr}` };
      }
    }
  } catch {
    return { valid: false, error: `Cannot resolve hostname: ${hostname}` };
  }

  return { valid: true, url: parsed };
}

// ─── Rate Limiting ───────────────────────────────────────────────────────────
const RL_STORE     = new Map();  // ip -> { count, windowStart }
const RL_WINDOW_MS = 60_000;     // 1-minute sliding window
const RL_MAX_REQ   = 5;          // max 5 crawl requests per window per IP

/**
 * Checks whether the given IP has exceeded the rate limit.
 * @param {string} ip
 * @returns {{ allowed: boolean, remaining: number, resetIn: number }}
 */
function checkRateLimit(ip) {
  const now   = Date.now();
  let rec     = RL_STORE.get(ip);

  if (!rec || now - rec.windowStart > RL_WINDOW_MS) {
    rec = { count: 0, windowStart: now };
  }

  rec.count += 1;
  RL_STORE.set(ip, rec);

  return {
    allowed:   rec.count <= RL_MAX_REQ,
    remaining: Math.max(0, RL_MAX_REQ - rec.count),
    resetIn:   Math.ceil((rec.windowStart + RL_WINDOW_MS - now) / 1000),
  };
}

module.exports = { validateUrl, checkRateLimit, isBlockedIp };
