/**
 * Import CMS Medicare Advantage Data
 *
 * Downloads and imports official Medicare Advantage enrollment data from CMS.
 * This includes plan enrollment, organization names, and state coverage.
 *
 * Usage:
 *   npm run import:cms:medicare              # Import latest data
 *   npm run import:cms:medicare -- --dry-run # Preview without importing
 *   npm run import:cms:medicare -- --year 2024 --month 10 # Specific period
 *   npm run import:cms:medicare -- --list    # List available periods
 *
 * Data source:
 *   https://www.cms.gov/data-research/statistics-trends-and-reports/medicare-advantagepart-d-contract-and-enrollment-data
 */

import cmsMedicare from '../scrapers/cms-medicare.js';
import db from '../db/index.js';
import fuzzy from '../utils/fuzzy-match.js';

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIST_PERIODS = args.includes('--list');
const YEAR_INDEX = args.indexOf('--year');
const MONTH_INDEX = args.indexOf('--month');
const SPECIFIC_YEAR = YEAR_INDEX !== -1 ? parseInt(args[YEAR_INDEX + 1], 10) : null;
const SPECIFIC_MONTH = MONTH_INDEX !== -1 ? parseInt(args[MONTH_INDEX + 1], 10) : null;

// Import statistics
const stats = {
  organizationsFound: 0,
  payersAdded: 0,
  payersUpdated: 0,
  errors: [],
};

/**
 * Get existing payers from database for deduplication
 */
async function getExistingPayers() {
  try {
    return await db.queryAll('SELECT id, name, member_count FROM payers');
  } catch (error) {
    console.log('⚠️  Could not load existing payers (database may not be set up)');
    return [];
  }
}

/**
 * Insert a new payer from CMS data
 */
async function insertPayer(org) {
  const result = await db.query(`
    INSERT INTO payers (
      name, type, states, member_count, data_sources
    ) VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [
    org.name,
    'Medicare Advantage',
    org.states,
    org.memberCount,
    ['CMS'],
  ]);

  return result.rows[0]?.id;
}

/**
 * Update an existing payer with CMS data
 */
async function updatePayer(id, org) {
  await db.query(`
    UPDATE payers SET
      member_count = $2,
      states = CASE
        WHEN array_length(states, 1) IS NULL OR array_length(states, 1) < array_length($3::text[], 1)
        THEN $3
        ELSE states
      END,
      type = CASE
        WHEN type = 'Other' OR type IS NULL THEN 'Medicare Advantage'
        ELSE type
      END,
      data_sources = CASE
        WHEN NOT ('CMS' = ANY(data_sources)) THEN array_append(data_sources, 'CMS')
        ELSE data_sources
      END,
      updated_at = NOW()
    WHERE id = $1
  `, [
    id,
    org.memberCount,
    org.states,
  ]);
}

/**
 * Process a single organization from CMS data
 */
async function processOrganization(org, existingPayers) {
  // Find existing match using fuzzy matching
  const match = fuzzy.findBestMatch(org.name, existingPayers);

  if (DRY_RUN) {
    const action = match ? 'UPDATE' : 'ADD';
    const matchInfo = match ? ` (matches: ${match.match.name}, confidence: ${match.confidence})` : '';
    console.log(`   [${action}] ${org.name} - ${org.memberCount.toLocaleString()} members${matchInfo}`);
    return;
  }

  try {
    if (match && (match.confidence === 'exact' || match.confidence === 'high')) {
      // Update existing payer
      await updatePayer(match.match.id, org);
      stats.payersUpdated++;
    } else {
      // Insert new payer
      await insertPayer(org);
      stats.payersAdded++;
    }
  } catch (error) {
    stats.errors.push(`${org.name}: ${error.message}`);
    console.error(`   ❌ Error processing ${org.name}: ${error.message}`);
  }
}

/**
 * Main import function
 */
async function runImport() {
  console.log('🏛️  CMS Medicare Advantage Import');
  console.log('==================================\n');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No changes will be made to the database\n');
  }

  // Handle --list flag
  if (LIST_PERIODS) {
    console.log('📋 Available data periods:\n');
    const periods = await cmsMedicare.getAvailablePeriods();

    if (periods.length === 0) {
      console.log('   Could not fetch available periods (CMS may be blocking)');
      console.log('   Try accessing directly: https://www.cms.gov/data-research/statistics-trends-and-reports/medicare-advantagepart-d-contract-and-enrollment-data/monthly-enrollment-contract/plan/state/county\n');
    } else {
      for (const p of periods.slice(0, 12)) {
        console.log(`   ${p.year}-${String(p.month).padStart(2, '0')}`);
      }
      console.log(`\n   Total: ${periods.length} periods available\n`);
    }
    return;
  }

  // Test database connection
  console.log('📦 Connecting to database...');
  const dbConnected = await db.testConnection();

  if (!dbConnected && !DRY_RUN) {
    console.error('❌ Cannot connect to database. Run migrations first: npm run migrate');
    process.exit(1);
  }

  // Get existing payers for deduplication
  const existingPayers = await getExistingPayers();
  console.log(`   Existing payers: ${existingPayers.length}\n`);

  // Fetch CMS data
  console.log('📥 Fetching Medicare Advantage enrollment data from CMS...\n');

  const organizations = await cmsMedicare.getLatestCPSCData(
    SPECIFIC_YEAR,
    SPECIFIC_MONTH
  );

  if (organizations.length === 0) {
    console.log('\n⚠️  No data retrieved from CMS.');
    console.log('   This could mean:');
    console.log('   - CMS is blocking automated access');
    console.log('   - The data format has changed');
    console.log('   - Network issues\n');
    console.log('   Try manually downloading from:');
    console.log('   https://www.cms.gov/data-research/statistics-trends-and-reports/medicare-advantagepart-d-contract-and-enrollment-data/monthly-enrollment-contract/plan/state/county\n');
    return;
  }

  stats.organizationsFound = organizations.length;
  console.log(`\n📊 Found ${organizations.length} Medicare Advantage organizations\n`);

  // Show top 10 by enrollment
  console.log('Top 10 by enrollment:');
  for (const org of organizations.slice(0, 10)) {
    console.log(`   ${org.name}: ${org.memberCount.toLocaleString()} members`);
  }
  console.log('');

  // Process each organization
  console.log('Processing organizations...\n');

  for (let i = 0; i < organizations.length; i++) {
    const org = organizations[i];

    if (i > 0 && i % 50 === 0) {
      console.log(`   Progress: ${i}/${organizations.length}`);
    }

    await processOrganization(org, existingPayers);
  }

  // Log import to database
  if (!DRY_RUN && dbConnected) {
    try {
      await db.query(`
        INSERT INTO import_logs (source, records_found, records_added, records_updated, errors, completed_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [
        'CMS Medicare',
        stats.organizationsFound,
        stats.payersAdded,
        stats.payersUpdated,
        stats.errors.slice(0, 10),
      ]);
    } catch (error) {
      console.log('⚠️  Could not log import');
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 IMPORT SUMMARY');
  console.log('='.repeat(50));
  console.log(`Organizations found: ${stats.organizationsFound}`);
  console.log(`Payers added:        ${stats.payersAdded}`);
  console.log(`Payers updated:      ${stats.payersUpdated}`);
  console.log(`Errors:              ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log('\n❌ Errors:');
    for (const error of stats.errors.slice(0, 5)) {
      console.log(`   - ${error}`);
    }
  }

  if (DRY_RUN) {
    console.log('\n⚠️  This was a dry run. No changes were made.');
    console.log('   Run without --dry-run to actually import data.');
  }

  // Show data directory
  console.log(`\n📁 Downloaded files saved to: ${cmsMedicare.getDataDir()}`);
  const files = cmsMedicare.listDownloadedFiles();
  if (files.length > 0) {
    console.log('   Files:');
    for (const file of files) {
      console.log(`   - ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
    }
  }

  console.log('');
}

// Run the import
runImport()
  .catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  })
  .finally(() => {
    db.closePool();
  });
