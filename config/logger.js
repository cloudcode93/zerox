'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Structured Winston logger.
 * 
 * Production: JSON format → parsable by log aggregation tools (Render, Datadog, etc.)
 * Development: Colorized, human-readable console output
 * 
 * Transports:
 *   - Console (always)
 *   - error.log file (errors only)
 *   - combined.log file (all levels)
 */
const logger = createLogger({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  defaultMeta: { service: 'zerox-api' },
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    isProduction
      ? format.json()
      : format.combine(
          format.colorize(),
          format.printf(({ timestamp, level, message, service, ...meta }) => {
            const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
            return `${timestamp} [${level}] ${message}${metaStr}`;
          })
        )
  ),
  transports: [
    new transports.Console(),
  ],
});

// File transports only in production (Render persists /tmp but not app dir)
if (isProduction) {
  const logsDir = path.join(__dirname, '../logs');
  logger.add(new transports.File({
    filename: path.join(logsDir, 'error.log'),
    level: 'error',
    maxsize: 5 * 1024 * 1024, // 5MB
    maxFiles: 3,
  }));
  logger.add(new transports.File({
    filename: path.join(logsDir, 'combined.log'),
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 3,
  }));
}

/**
 * Morgan stream adapter — pipes HTTP request logs into Winston
 */
logger.morganStream = {
  write: (message) => {
    logger.info(message.trim(), { type: 'http' });
  },
};

module.exports = logger;
