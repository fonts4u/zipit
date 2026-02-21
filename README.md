# SiteZip — Website to ZIP Downloader

A production-ready web application that crawls any public website, downloads all assets, rewrites internal paths, and packages everything into a downloadable ZIP archive.

---

## 📁 Project Structure

```
website-to-zip/
├── api/
│   └── download.js          # Vercel serverless API handler (POST /api/download)
├── lib/
│   ├── crawler.js            # Core crawler — Puppeteer + Cheerio pipeline
│   ├── assetDownloader.js    # Concurrent asset downloader (CSS, JS, images, fonts)
│   ├── pathRewriter.js       # Rewrites absolute URLs to local relative paths
│   ├── zipBuilder.js         # Streaming ZIP generation with archiver
│   ├── security.js           # SSRF protection, URL validation, input sanitization
│   ├── rateLimiter.js        # Sliding-window in-memory rate limiter
│   └── logger.js             # Structured logging with Winston
├── public/
│   └── index.html            # Frontend — vanilla JS, dark industrial UI
├── server.js                 # Local dev Express server (not used in Vercel)
├── package.json
├── vercel.json               # Vercel deployment configuration
└── README.md
```

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- Node.js 18+
- Google Chrome installed (for Puppeteer in local mode)

### Install & Run

```bash
# Clone or download the project
cd website-to-zip

# Install dependencies
npm install

# Set environment (optional)
export NODE_ENV=development
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"  # macOS
# export CHROME_PATH="/usr/bin/google-chrome-stable"  # Linux

# Start dev server
npm run dev

# Open browser
open http://localhost:3000
```

---

## ☁️ Vercel Deployment

### Step 1: Install Vercel CLI
```bash
npm install -g vercel
```

### Step 2: Login to Vercel
```bash
vercel login
```

### Step 3: Deploy
```bash
cd website-to-zip
vercel --prod
```

Vercel will auto-detect the configuration from `vercel.json`.

### Step 4: Configure Environment Variables (optional overrides)
In the Vercel dashboard → Project Settings → Environment Variables:

| Variable               | Default  | Description                          |
|------------------------|----------|--------------------------------------|
| `CRAWL_MAX_DEPTH`      | `1`      | How many link hops to follow         |
| `CRAWL_MAX_PAGES`      | `10`     | Maximum number of pages to crawl     |
| `ASSET_CONCURRENCY`    | `6`      | Concurrent asset downloads           |
| `RATE_LIMIT_MAX`       | `3`      | Requests per IP per window           |
| `RATE_LIMIT_WINDOW_MS` | `60000`  | Rate limit window (ms)               |
| `PAGE_TIMEOUT_MS`      | `25000`  | Per-page render timeout (ms)         |
| `CRAWL_TIMEOUT_MS`     | `55000`  | Total crawl timeout (ms)             |
| `MAX_ASSET_SIZE`       | `10485760`| Max asset size in bytes (10 MB)     |
| `LOG_LEVEL`            | `info`   | Logging level (debug/info/warn/error)|

### Vercel Plan Notes
- **Hobby (free):** 10s max function timeout — set `CRAWL_TIMEOUT_MS=9000`
- **Pro:** 60s max — default settings work well
- **Enterprise:** 900s — can enable deeper crawls

---

## 🏗️ Architecture & Pipeline

```
User URL input
    │
    ▼
[Security Layer]
    ├─ URL format validation
    ├─ Scheme check (http/https only)
    ├─ SSRF: blocked hostname check
    └─ SSRF: DNS resolution + IP range check

    │
    ▼
[Rate Limiter]
    └─ Sliding-window, per-IP, in-memory

    │
    ▼
[Puppeteer Browser]
    ├─ Launch headless Chromium (@sparticuz/chromium in serverless)
    ├─ Intercept network requests → collect asset URLs
    ├─ Navigate to URL with networkidle2 wait
    ├─ Auto-scroll for lazy-loaded images
    └─ Extract final rendered HTML

    │
    ▼
[Cheerio DOM Parser]
    ├─ Extract: <link>, <script>, <img>, <source>, srcset, style attrs
    ├─ Extract: CSS url() references
    └─ Extract: internal links for multi-page crawl

    │
    ▼
[Asset Downloader]
    ├─ Concurrent downloads (p-limit)
    ├─ Per-asset timeout (15s)
    ├─ Skip oversized assets (>10MB)
    ├─ Error-safe (skip, don't fail)
    └─ Save to /tmp/{sessionId}/site/...

    │
    ▼
[Path Rewriter]
    ├─ HTML: rewrite src, href, srcset, style attrs
    ├─ CSS: rewrite url() references
    └─ Remove <base> tags

    │
    ▼
[ZIP Builder]
    ├─ Stream all files into ZIP (archiver)
    ├─ Compression level 6
    └─ Add archive comment

    │
    ▼
[Response]
    ├─ Stream ZIP to client (Content-Disposition: attachment)
    └─ Schedule cleanup of /tmp/{sessionId}/ after 5s
```

---

## 🔒 Security Features

| Threat              | Mitigation                                                     |
|---------------------|----------------------------------------------------------------|
| SSRF                | Blocked IPs: 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x |
| SSRF (DNS rebinding)| Post-resolution IP check before HTTP request                   |
| Cloud metadata      | Blocked: 169.254.169.254, metadata.google.internal, etc.       |
| Path traversal      | sanitizeFilename() on all URL path segments                    |
| DDoS / abuse        | Rate limiting: 3 req/min per IP (configurable)                 |
| Oversized responses | MAX_ASSET_SIZE (10MB per asset), total timeout                 |
| Malformed input     | Zod-free but strict validation with descriptive errors         |

---

## ⚡ Scalability Suggestions

1. **Redis rate limiting** — Replace in-memory with `ioredis` + `rate-limiter-flexible` for multi-instance correctness.

2. **Job queue** — Move crawl to a background worker (BullMQ + Redis). Return a job ID immediately, poll for status, download when ready.

3. **S3 / R2 storage** — Save ZIPs to object storage instead of `/tmp`. Return a pre-signed download URL. Enables larger files and persistent links.

4. **CDN caching** — Cache ZIPs by URL hash for a short TTL (e.g., 10 min). Identical URL requests share the same archive.

5. **Separate crawl service** — Run Puppeteer in a dedicated container (e.g., on Fly.io or Railway) rather than serverless to avoid cold starts and timeout limits.

6. **Webhook callback** — For large sites, accept a `webhookUrl` in the request body. POST the ZIP URL to it when done.

7. **Database audit log** — Log all requests (timestamp, IP, URL, result, ZIP size) to a database for monitoring and abuse detection.

8. **Max ZIP size enforcement** — Abort the archive and return an error if the ZIP exceeds a configurable size limit.

---

## 🔮 Future SaaS Upgrade Ideas

| Feature                   | Description                                                |
|---------------------------|------------------------------------------------------------|
| **Scheduled archiving**   | Let users schedule recurring captures (daily/weekly)       |
| **Site diff alerts**      | Detect when a site changes; notify via email/webhook       |
| **Multi-site dashboard**  | Manage and re-download archives from a web dashboard       |
| **API access**            | Offer an authenticated REST API with API keys              |
| **Premium crawl depth**   | Paid tier: crawl entire sites (no page limit)              |
| **PDF export**            | Also render pages to PDF using Puppeteer's `.pdf()` method |
| **Visual sitemap**        | Generate an interactive visual sitemap from crawled links  |
| **Team sharing**          | Share archives within a team via invite links              |
| **Browser extension**     | One-click "Archive this tab" extension                     |
| **Playwright mode**       | Use Playwright for better cross-browser rendering fidelity |

---

## ⚠️ Known Limitations

1. **Serverless cold starts** — First request after idle may take 5-10 seconds to initialize Chromium.
2. **Complex SPAs** — Sites with WebSocket-based rendering, heavy WASM, or complex auth flows may not render correctly.
3. **Login-protected pages** — No cookie/session support; only public pages can be crawled.
4. **Dynamic asset loading** — Assets loaded via `IntersectionObserver` deep in the page may be missed despite auto-scrolling.
5. **Anti-bot measures** — Sites using Cloudflare Bot Management or reCAPTCHA may block headless Chromium.
6. **Font licensing** — Downloaded font files may be subject to licensing restrictions; users are responsible for compliance.
7. **ZIP size limits** — Vercel's 4.5MB response limit for Edge Functions doesn't apply here (Node.js streaming is used), but very large sites may hit memory limits.
8. **Rate limit not distributed** — In-memory rate limiter resets on function cold start; use Redis for strict enforcement.
9. **No deduplication across sessions** — Each crawl is independent; popular sites get downloaded fresh each time.

---

## 🛠️ Development

### Linting
```bash
npm run lint
```

### Adding a new asset type
1. Add the URL extraction to `extractAssetsFromHtml()` in `crawler.js`
2. Add the attribute rewriting to `rewriteHtml()` in `pathRewriter.js`
3. If the extension needs special handling, update `SKIP_EXTENSIONS` in `assetDownloader.js`

### Testing with a known site
```bash
curl -X POST http://localhost:3000/api/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}' \
  --output example.zip
```
