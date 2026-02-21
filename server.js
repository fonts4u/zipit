/**
 * server.js
 * Local development server wrapping the serverless handler in Express.
 * Not used in Vercel deployment - for local testing only.
 *
 * Usage: npm run dev
 */

'use strict';

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const logger = require('./lib/logger');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
  })
);

// Parse JSON bodies
console.log('Setting up JSON middleware...');
app.use(express.json({ limit: '1mb' }));

// Serve static frontend
console.log('Setting up static middleware...');
app.use(express.static(path.join(__dirname, 'public')));

// API routes
console.log('Setting up API routes...');
try {
  app.post('/api/download', require('./api/download'));
} catch (e) {
  console.error('Error requiring api/download:', e);
}

// Health check endpoint
console.log('Setting up health check...');
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: process.env.npm_package_version || '1.0.0',
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV || 'development',
  });
});

// Fallback: serve index.html for all other routes (SPA-friendly)
console.log('Setting up fallback route...');
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
console.log('Setting up error handler...');
app.use((err, req, res, next) => {
  logger.error('Unhandled server error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
console.log('Starting server listen...');
app.listen(PORT, () => {
  logger.info(`Development server running at http://localhost:${PORT}`);
  logger.info('Press Ctrl+C to stop');
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received. Shutting down gracefully...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

module.exports = app;
