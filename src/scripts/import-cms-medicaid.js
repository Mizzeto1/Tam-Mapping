/**
 * Import CMS Medicaid MCO Data
 *
 * Downloads and imports Medicaid Managed Care Organization enrollment data.
 * This includes state Medicaid MCOs with their enrollment numbers.
 *
 * Usage:
 *   npm run import:cms:medicaid              # Import latest data
 *   npm run import:cms:medicaid -- --dry-run # Preview without importing
 *
 * Data source:
 *   https://data.medicaid.gov/dataset/0bef7b8a-c663-5b14-9a46-0b5c2b86b0fe
 *   https://www.medicaid.gov/medicaid/managed-care/enrollment-report
 */

import cmsMedicaid from '../scrapers/cms-medicaid.js';
import db from '../db/index.js';
import fuzzy from '../utils/fuzzy-match.js';

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// Import statistics
const stats = {
  mcosFound: 0,
  payersAdded: 0,
  payersUpdated: 0,
  parentCompaniesFound: 0,
  errors: [],
};

/**
 * Get existing payers from database for deduplication
 */
async function getExistingPayers() {
  try {
    return await db.queryAll('SELECT id, name, member_count, states, parent_company FROM payers');
  } catch (error) {
    console.log('⚠️  Could not load existing payers (database may not be set up)');
    return [];
  }
}

/**
 * Insert a new payer from Medicaid MCO data
 */
async function insertPayer(mco) {
  const result = await db.query(`
    INSERT INTO payers (
      name, parent_company, type, states, member_count, data_sources
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [
    mco.name,
    mco.parentCompany,
    'MCO',
    mco.states,
    mco.memberCount,
    ['CMS'],
  ]);

  return result.rows[0]?.id;
}

/**
 * Update an existing payer with Medicaid MCO data
 */
async function updatePayer(id, mco, existingPayer) {
  // Merge states
  const existingStates = existingPayer.states || [];
  const newStates = mco.states || [];
  const mergedStates = [...new Set([...existingStates, ...newStates])];

  // Add member count (Medicaid is separate from Medicare)
  // For now, we'll take the larger value as the total
  const memberCount = Math.max(existingPayer.member_count || 0, mco.memberCount);

  await db.query(`
    UPDATE payers SET
      parent_company = COALESCE(parent_company, $2),
      states = $3,
      member_count = $4,
      type = CASE
        WHEN type = 'Other' OR type IS NULL THEN 'MCO'
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
    mco.parentCompany,
    mergedStates,
    memberCount,
  ]);
}

/**
 * Process a single MCO from Medicaid data
 */
async function processMCO(mco, existingPayers) {
  // First, try to match by parent company if known
  let match = null;

  if (mco.parentCompany) {
    // Look for existing entry with same parent company
    const parentMatch = existingPayers.find(p =>
      p.parent_company?.toLowerCase() === mco.parentCompany.toLowerCase()
    );

    if (parentMatch) {
      match = { match: parentMatch, confidence: 'high' };
    }
  }

  // If no parent match, try fuzzy matching on name
  if (!match) {
    match = fuzzy.findBestMatch(mco.name, existingPayers);
  }

  if (DRY_RUN) {
    const action = match ? 'UPDATE' : 'ADD';
    const matchInfo = match
      ? ` (matches: ${match.match.name}, confidence: ${match.confidence})`
      : '';
    const parentInfo = mco.parentCompany ? ` [Parent: ${mco.parentCompany}]` : '';

    console.log(`   [${action}] ${mco.name} - ${mco.memberCount.toLocaleString()} members${parentInfo}${matchInfo}`);

    if (mco.states.length > 0) {
      console.log(`            States: ${mco.states.join(', ')}`);
    }
    return;
  }

  try {
    if (match && (match.confidence === 'exact' || match.confidence === 'high')) {
      // Update existing payer
      await updatePayer(match.match.id, mco, match.match);
      stats.payersUpdated++;
    } else {
      // Insert new payer
      await insertPayer(mco);
      stats.payersAdded++;
    }

    if (mco.parentCompany) {
      stats.parentCompaniesFound++;
    }

  } catch (error) {
    stats.errors.push(`${mco.name}: ${error.message}`);
    console.error(`   ❌ Error processing ${mco.name}: ${error.message}`);
  }
}

/**
 * Main import function
 */
async function runImport() {
  console.log('🏛️  CMS Medicaid MCO Import');
  console.log('============================\n');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No changes will be made to the database\n');
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

  // Fetch Medicaid MCO data
  console.log('📥 Fetching Medicaid MCO enrollment data...\n');

  const mcos = await cmsMedicaid.getLatestMCOData();

  if (mcos.length === 0) {
    console.log('\n⚠️  No data retrieved from CMS Medicaid.');
    console.log('   This could mean:');
    console.log('   - API access is restricted');
    console.log('   - The data format has changed');
    console.log('   - Network issues\n');
    console.log('   Try manually downloading from:');
    console.log('   https://data.medicaid.gov/dataset/0bef7b8a-c663-5b14-9a46-0b5c2b86b0fe\n');
    return;
  }

  stats.mcosFound = mcos.length;
  console.log(`\n📊 Found ${mcos.length} Medicaid MCOs\n`);

  // Show top 15 by enrollment
  console.log('Top 15 Medicaid MCOs by enrollment:');
  for (const mco of mcos.slice(0, 15)) {
    const parent = mco.parentCompany ? ` (${mco.parentCompany})` : '';
    console.log(`   ${mco.name}${parent}: ${mco.memberCount.toLocaleString()} members`);
  }
  console.log('');

  // Show parent company summary
  const parentCounts = {};
  for (const mco of mcos) {
    if (mco.parentCompany) {
      parentCounts[mco.parentCompany] = (parentCounts[mco.parentCompany] || 0) + mco.memberCount;
    }
  }

  const topParents = Object.entries(parentCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10);

  if (topParents.length > 0) {
    console.log('Top parent companies by Medicaid enrollment:');
    for (const [parent, count] of topParents) {
      console.log(`   ${parent}: ${count.toLocaleString()} members`);
    }
    console.log('');
  }

  // Process each MCO
  console.log('Processing MCOs...\n');

  for (let i = 0; i < mcos.length; i++) {
    const mco = mcos[i];

    if (i > 0 && i % 50 === 0) {
      console.log(`   Progress: ${i}/${mcos.length}`);
    }

    await processMCO(mco, existingPayers);
  }

  // Log import to database
  if (!DRY_RUN && dbConnected) {
    try {
      await db.query(`
        INSERT INTO import_logs (source, records_found, records_added, records_updated, errors, completed_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [
        'CMS Medicaid',
        stats.mcosFound,
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
  console.log(`MCOs found:              ${stats.mcosFound}`);
  console.log(`Payers added:            ${stats.payersAdded}`);
  console.log(`Payers updated:          ${stats.payersUpdated}`);
  console.log(`Parent companies found:  ${stats.parentCompaniesFound}`);
  console.log(`Errors:                  ${stats.errors.length}`);

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
  console.log(`\n📁 Downloaded files saved to: ${cmsMedicaid.getDataDir()}`);
  const files = cmsMedicaid.listDownloadedFiles();
  if (files.length > 0) {
    console.log('   Medicaid files:');
    for (const file of files) {
      console.log(`   - ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);
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
