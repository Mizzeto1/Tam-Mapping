/**
 * Sync to Google Sheets
 *
 * This script pushes all collected payer data to your Google Sheet.
 * The Google Sheet acts as your UI for viewing and working with the data.
 *
 * Usage: npm run sync:sheets
 */

import config from '../config/index.js';
import sheets from '../sync/sheets.js';
import db from '../db/index.js';

async function syncSheets() {
  console.log('📊 Google Sheets Sync');
  console.log('====================\n');

  // Check configuration
  if (!config.google.sheetId) {
    console.log('❌ Google Sheet ID not configured.');
    console.log('   Add GOOGLE_SHEET_ID to your .env file\n');
    process.exit(1);
  }

  if (!config.google.credentialsJson && !config.google.credentialsPath) {
    console.log('❌ Google credentials not configured.');
    console.log('   Set GOOGLE_CREDENTIALS env var or GOOGLE_APPLICATION_CREDENTIALS path\n');
    process.exit(1);
  }

  console.log(`Sheet ID: ${config.google.sheetId}`);
  console.log(`Credentials: ${config.google.credentialsJson ? 'From env var' : config.google.credentialsPath}\n`);

  try {
    // Test database connection first
    console.log('📦 Checking database connection...');
    const dbConnected = await db.testConnection();

    if (!dbConnected) {
      console.log('⚠️  Database not connected. Syncing with empty data...\n');
    }

    // Test sheets connection
    console.log('🔗 Testing Google Sheets connection...');
    const connected = await sheets.testConnection();

    if (!connected) {
      console.log('\n❌ Cannot connect to Google Sheets.');
      console.log('   Check your credentials and sheet sharing settings.\n');
      process.exit(1);
    }

    // Run the full sync
    await sheets.syncAll();

    console.log('\n✅ Sync complete!');
    console.log(`\n📊 View your data: https://docs.google.com/spreadsheets/d/${config.google.sheetId}\n`);

  } catch (error) {
    console.error('\n❌ Sync failed:', error.message);
    process.exit(1);
  } finally {
    await db.closePool();
  }
}

syncSheets();
