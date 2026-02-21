const logger = require('./logger');

const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '3', 10);
const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);

const rateLimitMap = new Map();

/**
 * Middleware to limit requests per IP.
 */
function rateLimitMiddleware(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.ip || '127.0.0.1';
    const now = Date.now();

    const record = rateLimitMap.get(ip) || { count: 0, windowStart: now };

    // Reset window if expired
    if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
        record.count = 0;
        record.windowStart = now;
    }

    // Increment count
    record.count++;
    rateLimitMap.set(ip, record);

    // Check limit
    if (record.count > RATE_LIMIT_MAX) {
        logger.warn('Rate limit exceeded', { ip });
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
    }

    next();
}

module.exports = { rateLimitMiddleware };
