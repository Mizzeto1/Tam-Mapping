/**
 * Import Apollo.io Data
 *
 * This script imports contact and company data from Apollo.io API.
 * It's useful for enriching your payer database with decision-maker contacts.
 *
 * Usage: npm run import:apollo
 */

import config from '../config/index.js';

async function importApollo() {
  console.log('🚀 Starting Apollo.io import...\n');

  if (!config.apollo.hasApiKey) {
    console.log('⚠️  Apollo API key not configured.');
    console.log('   To use this feature:');
    console.log('   1. Sign up at https://www.apollo.io/');
    console.log('   2. Get your API key from Settings > API');
    console.log('   3. Add APOLLO_API_KEY to your .env file\n');
    process.exit(0);
  }

  // TODO: Implement Apollo.io API integration
  console.log('📝 Apollo import not yet implemented.');
  console.log('   This will be added in a future phase.\n');
}

importApollo().catch(console.error);
