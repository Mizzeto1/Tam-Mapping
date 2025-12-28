/**
 * Full Data Refresh Orchestration
 *
 * This is the main entry point for refreshing all payer data.
 * It runs imports, deduplication, and syncs to Google Sheets.
 *
 * Usage:
 *   npm run refresh                    # Full refresh of all data
 *   npm run refresh -- --source=apollo # Only run Apollo import
 *   npm run refresh -- --source=cms    # Only run CMS imports
 *   npm run refresh -- --sync-only     # Skip imports, just sync to sheets
 *   npm run refresh -- --dry-run       # Preview without changes
 *
 * Sequence:
 *   1. Apollo.io companies (new + updates)
 *   2. CMS Medicare Advantage data
 *   3. CMS Medicaid MCO data
 *   4. Classify any new TPAs
 *   5. Deduplication pass (report only)
 *   6. Sync to Google Sheets
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import db from '../db/index.js';
import sheets from '../sync/sheets.js';
import fuzzy from '../utils/fuzzy-match.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SYNC_ONLY = args.includes('--sync-only');
const SOURCE_ARG = args.find(a => a.startsWith('--source='));
const SOURCE_FILTER = SOURCE_ARG ? SOURCE_ARG.split('=')[1].toLowerCase() : null;

// Timing helper
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Statistics
const stats = {
  startTime: null,
  steps: [],
  payersBefore: 0,
  payersAfter: 0,
  tpasBefore: 0,
  tpasAfter: 0,
  contactsBefore: 0,
  contactsAfter: 0,
  potentialDuplicates: [],
  errors: [],
};

/**
 * Run a script as a child process
 */
function runScript(name, scriptPath, scriptArgs = []) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📋 ${name}`);
    console.log('─'.repeat(60));

    const child = spawn('node', [scriptPath, ...scriptArgs], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    child.on('close', (code) => {
      const duration = Date.now() - startTime;
      stats.steps.push({ name, duration, success: code === 0 });

      if (code === 0) {
        console.log(`\n✅ ${name} completed in ${formatDuration(duration)}`);
        resolve();
      } else {
        const error = `${name} exited with code ${code}`;
        stats.errors.push(error);
        console.log(`\n⚠️ ${error}`);
        // Don't reject - continue with other steps
        resolve();
      }
    });

    child.on('error', (err) => {
      const error = `${name}: ${err.message}`;
      stats.errors.push(error);
      console.error(`\n❌ ${error}`);
      resolve(); // Continue with other steps
    });
  });
}

/**
 * Get current counts from database
 */
async function getCounts() {
  try {
    const payers = await db.queryOne('SELECT COUNT(*) as count FROM payers');
    const tpas = await db.queryOne('SELECT COUNT(*) as count FROM tpas');
    const contacts = await db.queryOne('SELECT COUNT(*) as count FROM contacts');
    return {
      payers: parseInt(payers?.count || 0),
      tpas: parseInt(tpas?.count || 0),
      contacts: parseInt(contacts?.count || 0),
    };
  } catch {
    return { payers: 0, tpas: 0, contacts: 0 };
  }
}

/**
 * Run deduplication pass - find potential duplicates
 */
async function runDeduplication() {
  const startTime = Date.now();

  console.log(`\n${'─'.repeat(60)}`);
  console.log('🔍 Deduplication Pass');
  console.log('─'.repeat(60));

  try {
    // Get all payers
    const payers = await db.queryAll(`
      SELECT id, name, parent_company, member_count, states
      FROM payers
      ORDER BY name
    `);

    console.log(`\n   Analyzing ${payers.length} payers for duplicates...`);

    // Find potential duplicates using fuzzy matching
    const potentialDuplicates = [];
    const processed = new Set();

    for (let i = 0; i < payers.length; i++) {
      if (processed.has(i)) continue;

      const payer = payers[i];
      const normalizedName = fuzzy.normalizeName(payer.name);
      const group = [payer];

      for (let j = i + 1; j < payers.length; j++) {
        if (processed.has(j)) continue;

        const other = payers[j];
        const otherNormalized = fuzzy.normalizeName(other.name);

        // Check for exact normalized match or very high similarity
        if (normalizedName === otherNormalized) {
          group.push(other);
          processed.add(j);
        } else {
          // Use fuzzy matching for near-duplicates
          const match = fuzzy.findBestMatch(payer.name, [other]);
          if (match && (match.confidence === 'exact' || match.confidence === 'high')) {
            group.push(other);
            processed.add(j);
          }
        }
      }

      if (group.length > 1) {
        potentialDuplicates.push(group);
      }

      processed.add(i);
    }

    stats.potentialDuplicates = potentialDuplicates;

    if (potentialDuplicates.length > 0) {
      console.log(`\n   ⚠️ Found ${potentialDuplicates.length} potential duplicate groups:\n`);

      // Show first 10 duplicate groups
      for (const group of potentialDuplicates.slice(0, 10)) {
        console.log(`   📋 Potential duplicates:`);
        for (const payer of group) {
          const members = payer.member_count ? ` (${payer.member_count.toLocaleString()} members)` : '';
          console.log(`      - [ID ${payer.id}] ${payer.name}${members}`);
        }
        console.log('');
      }

      if (potentialDuplicates.length > 10) {
        console.log(`   ... and ${potentialDuplicates.length - 10} more groups`);
      }

      console.log('\n   ℹ️  Duplicates are logged but NOT auto-merged (too risky).');
      console.log('   Review manually and use SQL to merge if needed.');
    } else {
      console.log('\n   ✅ No obvious duplicates found');
    }

    const duration = Date.now() - startTime;
    stats.steps.push({ name: 'Deduplication Pass', duration, success: true });
    console.log(`\n✅ Deduplication completed in ${formatDuration(duration)}`);

  } catch (error) {
    console.error(`\n❌ Deduplication error: ${error.message}`);
    stats.errors.push(`Deduplication: ${error.message}`);
  }
}

/**
 * Sync to Google Sheets
 */
async function runSync() {
  const startTime = Date.now();

  console.log(`\n${'─'.repeat(60)}`);
  console.log('📊 Google Sheets Sync');
  console.log('─'.repeat(60));

  if (DRY_RUN) {
    console.log('\n   ⚠️ DRY RUN - Skipping actual sync');
    stats.steps.push({ name: 'Google Sheets Sync', duration: 0, success: true, skipped: true });
    return;
  }

  try {
    // Test connection first
    const connected = await sheets.testConnection();
    if (!connected) {
      throw new Error('Could not connect to Google Sheets');
    }

    // Sync all tabs
    await sheets.syncAll();

    // Log the refresh to the Logs tab
    await sheets.logImport('Full Refresh', {
      found: stats.payersAfter,
      added: stats.payersAfter - stats.payersBefore,
      updated: 0, // We don't track this separately yet
      errors: stats.errors,
    });

    const duration = Date.now() - startTime;
    stats.steps.push({ name: 'Google Sheets Sync', duration, success: true });
    console.log(`\n✅ Sync completed in ${formatDuration(duration)}`);

  } catch (error) {
    console.error(`\n❌ Sync error: ${error.message}`);
    stats.errors.push(`Sheets Sync: ${error.message}`);
    stats.steps.push({ name: 'Google Sheets Sync', duration: Date.now() - startTime, success: false });
  }
}

/**
 * Print final summary
 */
function printSummary() {
  const totalDuration = Date.now() - stats.startTime;

  console.log('\n' + '═'.repeat(60));
  console.log('📊 REFRESH SUMMARY');
  console.log('═'.repeat(60));

  // Data counts
  console.log('\n📈 DATA COUNTS:');
  console.log(`   Health Plans:  ${stats.payersBefore} → ${stats.payersAfter} (${stats.payersAfter - stats.payersBefore >= 0 ? '+' : ''}${stats.payersAfter - stats.payersBefore})`);
  console.log(`   TPAs:          ${stats.tpasBefore} → ${stats.tpasAfter} (${stats.tpasAfter - stats.tpasBefore >= 0 ? '+' : ''}${stats.tpasAfter - stats.tpasBefore})`);
  console.log(`   Contacts:      ${stats.contactsBefore} → ${stats.contactsAfter} (${stats.contactsAfter - stats.contactsBefore >= 0 ? '+' : ''}${stats.contactsAfter - stats.contactsBefore})`);

  // Duplicates
  if (stats.potentialDuplicates.length > 0) {
    console.log(`\n⚠️  POTENTIAL DUPLICATES: ${stats.potentialDuplicates.length} groups found`);
  }

  // Step timing
  console.log('\n⏱️  STEP TIMING:');
  for (const step of stats.steps) {
    const status = step.skipped ? '⏭️' : step.success ? '✅' : '❌';
    console.log(`   ${status} ${step.name}: ${formatDuration(step.duration)}`);
  }

  // Errors
  if (stats.errors.length > 0) {
    console.log(`\n❌ ERRORS (${stats.errors.length}):`);
    for (const error of stats.errors.slice(0, 5)) {
      console.log(`   - ${error}`);
    }
    if (stats.errors.length > 5) {
      console.log(`   ... and ${stats.errors.length - 5} more`);
    }
  }

  // Total time
  console.log(`\n⏱️  TOTAL TIME: ${formatDuration(totalDuration)}`);

  if (DRY_RUN) {
    console.log('\n⚠️  This was a DRY RUN - no changes were made.');
  }

  console.log('');
}

/**
 * Main refresh function
 */
async function runRefresh() {
  stats.startTime = Date.now();

  console.log('🔄 PAYER UNIVERSE REFRESH');
  console.log('═'.repeat(60));
  console.log(`   Started: ${new Date().toLocaleString()}`);

  if (DRY_RUN) {
    console.log('   Mode: DRY RUN (no changes will be made)');
  } else if (SYNC_ONLY) {
    console.log('   Mode: SYNC ONLY (skip imports)');
  } else if (SOURCE_FILTER) {
    console.log(`   Mode: SOURCE FILTER (${SOURCE_FILTER} only)`);
  } else {
    console.log('   Mode: FULL REFRESH');
  }

  // Test database connection
  console.log('\n📦 Connecting to database...');
  const dbConnected = await db.testConnection();

  if (!dbConnected) {
    console.error('❌ Cannot connect to database. Run migrations first: npm run migrate');
    process.exit(1);
  }

  // Get initial counts
  const before = await getCounts();
  stats.payersBefore = before.payers;
  stats.tpasBefore = before.tpas;
  stats.contactsBefore = before.contacts;

  console.log(`\n   Current data: ${before.payers} payers, ${before.tpas} TPAs, ${before.contacts} contacts`);

  // ========================================
  // STEP 1-4: Run imports (unless sync-only)
  // ========================================

  if (!SYNC_ONLY) {
    const importArgs = DRY_RUN ? ['--dry-run'] : [];

    // Step 1: Apollo.io import
    if (!SOURCE_FILTER || SOURCE_FILTER === 'apollo') {
      await runScript(
        'Apollo.io Import',
        path.join(__dirname, 'import-apollo.js'),
        importArgs
      );
    }

    // Step 2: CMS Medicare import
    if (!SOURCE_FILTER || SOURCE_FILTER === 'cms' || SOURCE_FILTER === 'medicare') {
      await runScript(
        'CMS Medicare Advantage Import',
        path.join(__dirname, 'import-cms-medicare.js'),
        importArgs
      );
    }

    // Step 3: CMS Medicaid import
    if (!SOURCE_FILTER || SOURCE_FILTER === 'cms' || SOURCE_FILTER === 'medicaid') {
      await runScript(
        'CMS Medicaid MCO Import',
        path.join(__dirname, 'import-cms-medicaid.js'),
        importArgs
      );
    }

    // Step 4: Classify new TPAs
    if (!SOURCE_FILTER || SOURCE_FILTER === 'tpas') {
      await runScript(
        'TPA Classification',
        path.join(__dirname, 'classify-tpas.js'),
        importArgs
      );
    }

    // Note: Core system detection is skipped (manual only)
    console.log(`\n${'─'.repeat(60)}`);
    console.log('⏭️  Core System Detection - SKIPPED (run manually: npm run detect:systems)');
    console.log('─'.repeat(60));
  }

  // ========================================
  // STEP 5: Deduplication pass
  // ========================================

  if (!SYNC_ONLY || SOURCE_FILTER) {
    await runDeduplication();
  }

  // ========================================
  // STEP 6: Sync to Google Sheets
  // ========================================

  await runSync();

  // Get final counts
  const after = await getCounts();
  stats.payersAfter = after.payers;
  stats.tpasAfter = after.tpas;
  stats.contactsAfter = after.contacts;

  // Print summary
  printSummary();
}

// Run the refresh
runRefresh()
  .catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  })
  .finally(() => {
    db.closePool();
  });
