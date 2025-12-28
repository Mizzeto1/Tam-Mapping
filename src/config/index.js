/**
 * Configuration loader for Payer Universe
 *
 * This file loads environment variables and provides
 * them in a structured way to the rest of the application.
 *
 * Railway auto-provides:
 *   - DATABASE_URL (PostgreSQL connection string)
 *   - RAILWAY_ENVIRONMENT (production, staging, etc.)
 *   - PORT (for web services)
 */

import dotenv from 'dotenv';

// Load .env file (only needed in development)
dotenv.config();

// Detect Railway environment
const isRailway = !!process.env.RAILWAY_ENVIRONMENT;
const isProd = process.env.NODE_ENV === 'production' || isRailway;

/**
 * Validates that required environment variables are set
 * @param {string[]} required - List of required variable names
 */
function validateEnv(required) {
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    console.error('\n📝 Set these in Railway dashboard or .env file');
    process.exit(1);
  }
}

// Check for critical variables in production
if (isProd) {
  validateEnv(['GOOGLE_SHEET_ID', 'DATABASE_URL']);
}

/**
 * Application configuration object
 * Access settings like: config.google.sheetId
 */
const config = {
  // Environment
  env: process.env.NODE_ENV || (isRailway ? 'production' : 'development'),
  isDev: !isProd,
  isProd,
  isRailway,

  // Server (for health checks)
  port: parseInt(process.env.PORT, 10) || 3000,

  // Google Sheets
  google: {
    sheetId: process.env.GOOGLE_SHEET_ID,
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials/google-service-account.json',
    // For Railway: paste the entire JSON content into GOOGLE_CREDENTIALS env var
    credentialsJson: process.env.GOOGLE_CREDENTIALS || null,
  },

  // Apollo.io API
  apollo: {
    apiKey: process.env.APOLLO_API_KEY,
    hasApiKey: !!process.env.APOLLO_API_KEY,
  },

  // Database (Railway provides DATABASE_URL automatically)
  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/payer_universe',
    // Railway Postgres requires SSL
    ssl: isProd,
    // Connection pool settings
    pool: {
      max: parseInt(process.env.DB_POOL_MAX, 10) || 10,
      idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT, 10) || 30000,
      connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT, 10) || 5000,
    },
  },

  // CMS Data Sources
  cms: {
    marketDataUrl: process.env.CMS_MARKET_DATA_URL || 'https://www.cms.gov/marketplace',
    naicUrl: process.env.NAIC_DATA_URL || 'https://content.naic.org/',
  },

  // Sync Settings
  sync: {
    batchSize: parseInt(process.env.BATCH_SIZE, 10) || 100,
    apiDelayMs: parseInt(process.env.API_DELAY_MS, 10) || 1000,
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
    // JSON logs in production for Railway log aggregation
    format: isProd ? 'json' : 'pretty',
  },
};

export default config;
