'use strict';

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

/**
 * Firebase Admin SDK initialization.
 * 
 * Priority:
 *   1. Environment variables (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)
 *   2. Local JSON file (firebase-service-account.json) — dev only
 *   3. Disabled — push notifications won't work
 */
function initFirebase() {
  // Already initialized check
  if (admin.apps.length > 0) {
    logger.info('[Firebase] Already initialized');
    return;
  }

  // Method 1: Environment variables (production — Render, Railway, etc.)
  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
      logger.info('[Firebase] Initialized via environment variables');
      return;
    } catch (err) {
      logger.error('[Firebase] Failed to initialize via env vars:', err.message);
    }
  }

  // Method 2: JSON file (local development)
  const serviceAccountPath = path.join(__dirname, '../firebase-service-account.json');
  if (fs.existsSync(serviceAccountPath)) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(require(serviceAccountPath)),
      });
      logger.info('[Firebase] Initialized via JSON file');
      return;
    } catch (err) {
      logger.error('[Firebase] Failed to initialize via JSON file:', err.message);
    }
  }

  logger.warn('[Firebase] No credentials found — push notifications disabled');
}

module.exports = { initFirebase };
