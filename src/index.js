/**
 * Payer Universe - Main Entry Point
 *
 * This is the main file that runs when you start the application.
 * It can be used to run the server or execute specific tasks.
 */

import config from './config/index.js';

console.log('🏥 Payer Universe - Healthcare Payer Database');
console.log('============================================');
console.log(`Environment: ${config.env}`);
console.log(`Google Sheet ID: ${config.google.sheetId ? '✓ Configured' : '✗ Not set'}`);
console.log(`Apollo API: ${config.apollo.hasApiKey ? '✓ Configured' : '✗ Not set (optional)'}`);
console.log(`Database: ${config.database.url ? '✓ Configured' : '✗ Not set'}`);
console.log('============================================');
console.log('\nAvailable commands:');
console.log('  npm run import:apollo  - Import data from Apollo.io');
console.log('  npm run import:cms     - Import data from CMS sources');
console.log('  npm run sync:sheets    - Sync data to Google Sheets');
console.log('  npm run refresh        - Run all imports + sync');
console.log('\nFor more info, see README.md');
