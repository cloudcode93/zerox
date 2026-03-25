'use strict';

const logger = require('../config/logger');

/**
 * Global error handler middleware.
 * Must be registered LAST (after all routes).
 * 
 * Catches unhandled errors from route handlers and returns
 * a clean JSON response instead of crashing the server.
 */
function errorHandler(err, req, res, _next) {
  // Log the full error
  logger.error('Unhandled route error', {
    message: err.message,
    stack: err.stack,
    method: req.method,
    url: req.originalUrl,
    ip: req.ip,
  });

  // Don't leak stack traces in production
  const isProduction = process.env.NODE_ENV === 'production';

  res.status(err.status || 500).json({
    error: isProduction ? 'Internal server error' : err.message,
  });
}

module.exports = errorHandler;
