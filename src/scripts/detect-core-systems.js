/**
 * Core System Detection Script (BETA)
 *
 * Analyzes job postings to detect which core claims/admin systems
 * healthcare payers are using. This is run on-demand only.
 *
 * Usage:
 *   npm run detect:systems              # Detect for payers without core_system
 *   npm run detect:systems -- --dry-run # Preview without updating database
 *   npm run detect:systems -- --all     # Re-analyze all payers
 *   npm run detect:systems -- --id 123  # Analyze a specific payer by ID
 *
 * Core systems detected:
 *   QNXT, Facets, HealthEdge, TriZetto, Cognizant, Amisys, Javelina, Diamond, HealthRules
 *
 * NOTE: This is BETA functionality. Job posting scraping is rate-limited
 * to 1 request per 5+ seconds to avoid detection.
 */

import jobScraper from '../scrapers/job-scraper.js';
import db from '../db/index.js';

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ANALYZE_ALL = args.includes('--all');
const SPECIFIC_ID_INDEX = args.indexOf('--id');
const SPECIFIC_ID = SPECIFIC_ID_INDEX !== -1 ? parseInt(args[SPECIFIC_ID_INDEX + 1], 10) : null;

// Statistics
const stats = {
  total: 0,
  systemsDetected: 0,
  noSystemFound: 0,
  errors: [],
  systemCounts: {},
};

/**
 * Get payers to analyze
 */
async function getPayersToAnalyze() {
  let query;
  let params = [];

  if (SPECIFIC_ID) {
    query = 'SELECT id, name, website FROM payers WHERE id = $1';
    params = [SPECIFIC_ID];
  } else if (ANALYZE_ALL) {
    query = 'SELECT id, name, website FROM payers WHERE website IS NOT NULL ORDER BY member_count DESC NULLS LAST';
  } else {
    // Only payers without core_system detected
    query = `
      SELECT id, name, website FROM payers
      WHERE website IS NOT NULL
        AND (core_system IS NULL OR core_system = '')
      ORDER BY member_count DESC NULLS LAST
    `;
  }

  try {
    return await db.queryAll(query, params);
  } catch (error) {
    console.log('⚠️  Could not load payers (database may not be set up)');
    return [];
  }
}

/**
 * Update payer with detected core system
 */
async function updatePayer(id, coreSystem, coreSystemVendor, confidence) {
  await db.query(`
    UPDATE payers SET
      core_system = $2,
      core_system_source = 'Job Posting',
      updated_at = NOW()
    WHERE id = $1
  `, [id, coreSystem]);
}

/**
 * Process a single payer
 */
async function processPayer(payer) {
  console.log(`\n📋 ${payer.name}`);

  if (!payer.website) {
    console.log(`   ⚠️ No website - skipping`);
    stats.noSystemFound++;
    return null;
  }

  try {
    const result = await jobScraper.analyzeCompanyJobs(payer.website, payer.name);

    // Log result
    console.log(`   ${jobScraper.formatResult(result)}`);

    if (result.coreSystem) {
      stats.systemsDetected++;
      stats.systemCounts[result.coreSystem] = (stats.systemCounts[result.coreSystem] || 0) + 1;

      if (!DRY_RUN) {
        await updatePayer(payer.id, result.coreSystem, result.coreSystemVendor, result.confidence);
      }
    } else {
      stats.noSystemFound++;
    }

    return result;

  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    stats.errors.push({ id: payer.id, name: payer.name, error: error.message });
    stats.noSystemFound++;
    return null;
  }
}

/**
 * Main function
 */
async function runDetection() {
  console.log('🔍 Core System Detection (BETA)');
  console.log('================================\n');

  console.log('⚠️  BETA: This feature analyzes job postings to detect core systems.');
  console.log('   Rate limiting: 5+ seconds between requests.\n');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No changes will be made to the database\n');
  }

  if (ANALYZE_ALL) {
    console.log('📋 Mode: Analyzing ALL payers with websites\n');
  } else if (SPECIFIC_ID) {
    console.log(`📋 Mode: Analyzing specific payer ID: ${SPECIFIC_ID}\n`);
  } else {
    console.log('📋 Mode: Analyzing payers without core_system detected\n');
  }

  // Show core systems we detect
  console.log('Core systems detected:');
  for (const system of jobScraper.CORE_SYSTEMS.slice(0, 8)) {
    console.log(`   • ${system.name} (${system.vendor})`);
  }
  console.log('');

  // Test database connection
  console.log('📦 Connecting to database...');
  const dbConnected = await db.testConnection();

  if (!dbConnected && !DRY_RUN) {
    console.error('❌ Cannot connect to database. Run migrations first: npm run migrate');
    process.exit(1);
  }

  // Get payers to analyze
  const payers = await getPayersToAnalyze();
  stats.total = payers.length;

  if (payers.length === 0) {
    console.log('\n✅ No payers to analyze.');
    if (!ANALYZE_ALL && !SPECIFIC_ID) {
      console.log('   Use --all to re-analyze all payers with websites.');
    }
    return;
  }

  console.log(`\n📊 Found ${payers.length} payers to analyze\n`);
  console.log('⏱️  Rate limiting: 5+ seconds between requests');
  console.log('   This will take a while for large datasets...\n');

  // Estimate time
  const estimatedMinutes = Math.ceil((payers.length * 8 * 5) / 60); // 8 URLs per payer, 5s each
  console.log(`   Estimated time: ${estimatedMinutes} minutes\n`);

  // Process each payer
  for (let i = 0; i < payers.length; i++) {
    const payer = payers[i];
    const progress = `[${i + 1}/${payers.length}]`;

    console.log(`\n${progress} Processing: ${payer.name}`);

    await processPayer(payer);

    // Progress update every 5 payers
    if ((i + 1) % 5 === 0) {
      const pct = Math.round((i + 1) / payers.length * 100);
      console.log(`\n   --- Progress: ${i + 1}/${payers.length} (${pct}%) | Systems found: ${stats.systemsDetected} ---`);
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 DETECTION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total payers analyzed:    ${stats.total}`);
  console.log(`Systems detected:         ${stats.systemsDetected}`);
  console.log(`No system found:          ${stats.noSystemFound}`);
  console.log(`Errors:                   ${stats.errors.length}`);

  // Print system breakdown
  if (Object.keys(stats.systemCounts).length > 0) {
    console.log('\nCore systems breakdown:');
    const sortedSystems = Object.entries(stats.systemCounts)
      .sort(([, a], [, b]) => b - a);

    for (const [system, count] of sortedSystems) {
      const pct = Math.round(count / stats.systemsDetected * 100);
      console.log(`   ${system}: ${count} (${pct}%)`);
    }
  }

  // Print errors
  if (stats.errors.length > 0) {
    console.log('\n❌ Errors:');
    for (const error of stats.errors.slice(0, 5)) {
      console.log(`   - ${error.name}: ${error.error}`);
    }
    if (stats.errors.length > 5) {
      console.log(`   ... and ${stats.errors.length - 5} more`);
    }
  }

  if (DRY_RUN) {
    console.log('\n⚠️  This was a dry run. No changes were made.');
    console.log('   Run without --dry-run to actually update the database.');
  }

  console.log('');
}

// Run detection
runDetection()
  .catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  })
  .finally(() => {
    db.closePool();
  });
