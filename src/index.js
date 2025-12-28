/**
 * Payer Universe - Main Entry Point
 *
 * This is the main file that runs when you start the application.
 * In production (Railway), it displays status and available commands.
 *
 * For scheduled tasks, use Railway's cron feature to run:
 *   npm run refresh
 */

import config from './config/index.js';
import logger from './utils/logger.js';
import db from './db/index.js';

// ============================================
// GLOBAL ERROR HANDLING
// ============================================

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  // Give time for logs to flush
  setTimeout(() => process.exit(1), 1000);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await db.closePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await db.closePool();
  process.exit(0);
});

// ============================================
// STARTUP
// ============================================

async function main() {
  // Log startup
  logger.info('Payer Universe starting', {
    env: config.env,
    railway: config.isRailway,
    nodeVersion: process.version,
  });

  // Display configuration status
  console.log('\n🏥 Payer Universe - Healthcare Payer Database');
  console.log('============================================');
  console.log(`Environment: ${config.env}${config.isRailway ? ' (Railway)' : ''}`);
  console.log(`Google Sheet: ${config.google.sheetId ? '✓ Configured' : '✗ Not set'}`);
  console.log(`Google Creds: ${config.google.credentialsJson ? '✓ JSON env var' : config.google.credentialsPath ? '✓ File path' : '✗ Not set'}`);
  console.log(`Apollo API: ${config.apollo.hasApiKey ? '✓ Configured' : '○ Not set (optional)'}`);
  console.log(`Database: ${config.database.url ? '✓ Configured' : '✗ Not set'}`);
  console.log(`Log Level: ${config.logging.level}`);
  console.log('============================================');

  // Test database connection
  console.log('\n📦 Testing database connection...');
  const dbConnected = await db.testConnection();

  if (!dbConnected) {
    logger.warn('Database connection failed - run migrations first');
    console.log('\n⚠️  Database not connected. Run: npm run migrate');
  }

  // Show available commands
  console.log('\n📋 Available commands:');
  console.log('  npm run migrate        - Set up database tables');
  console.log('  npm run import:apollo  - Import data from Apollo.io');
  console.log('  npm run import:cms     - Import data from CMS sources');
  console.log('  npm run classify:tpas  - Classify TPAs as healthcare/non-healthcare');
  console.log('  npm run detect:systems - Detect core systems from job postings (BETA)');
  console.log('  npm run sync:sheets    - Sync data to Google Sheets');
  console.log('  npm run refresh        - Run all imports + sync');
  console.log('  npm run test:sheets    - Test Google Sheets connection');

  // Railway-specific info
  if (config.isRailway) {
    console.log('\n🚂 Railway Deployment:');
    console.log('  - Use Railway cron to schedule: npm run refresh');
    console.log('  - View logs in Railway dashboard');
    console.log('  - Trigger manual runs via Railway CLI: railway run npm run refresh');
  }

  console.log('\n✅ Ready');

  // Close the database pool after status check
  await db.closePool();
}

// Run main
main().catch((error) => {
  logger.error('Startup failed', { error: error.message });
  process.exit(1);
});
