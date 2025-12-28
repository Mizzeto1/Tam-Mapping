/**
 * Configuration loader for Payer Universe
 *
 * This file loads environment variables and provides
 * them in a structured way to the rest of the application.
 */

import dotenv from 'dotenv';

// Load .env file (only needed in development)
dotenv.config();

/**
 * Validates that required environment variables are set
 * @param {string[]} required - List of required variable names
 */
function validateEnv(required) {
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    console.error('\n📝 Copy .env.example to .env and fill in your values');
    process.exit(1);
  }
}

// Check for critical variables
const requiredVars = ['GOOGLE_SHEET_ID'];

// Only validate in production or when explicitly running sync
if (process.env.NODE_ENV === 'production') {
  validateEnv(requiredVars);
}

/**
 * Application configuration object
 * Access settings like: config.google.sheetId
 */
const config = {
  // Environment
  env: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
  isProd: process.env.NODE_ENV === 'production',

  // Google Sheets
  google: {
    sheetId: process.env.GOOGLE_SHEET_ID,
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials/google-service-account.json',
  },

  // Apollo.io API
  apollo: {
    apiKey: process.env.APOLLO_API_KEY,
    hasApiKey: !!process.env.APOLLO_API_KEY,
  },

  // Database
  database: {
    url: process.env.DATABASE_URL || 'postgresql://localhost:5432/payer_universe',
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
    level: process.env.LOG_LEVEL || 'info',
  },
};

export default config;
