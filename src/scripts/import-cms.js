/**
 * Import CMS Data (All Sources)
 *
 * This script imports healthcare payer data from all CMS sources.
 * It runs all available CMS importers in sequence.
 *
 * Usage:
 *   npm run import:cms              # Run all CMS imports
 *   npm run import:cms -- --dry-run # Preview without importing
 *
 * Individual importers:
 *   npm run import:cms:medicare     # Medicare Advantage data only
 *
 * Data sources:
 *   - Medicare Advantage enrollment (CPSC data)
 *   - More coming: Medicaid MCOs, ACA exchange plans
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

// List of CMS importers to run
const IMPORTERS = [
  {
    name: 'Medicare Advantage',
    script: 'import-cms-medicare.js',
    description: 'Medicare Advantage enrollment from CPSC files',
  },
  // Future importers:
  // { name: 'Medicaid MCOs', script: 'import-cms-medicaid.js', description: 'State Medicaid MCO data' },
  // { name: 'ACA Exchange', script: 'import-cms-aca.js', description: 'Health Insurance Exchange data' },
];

/**
 * Run a single importer script
 */
function runImporter(importer) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, importer.script);
    const importerArgs = DRY_RUN ? ['--dry-run'] : [];

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📋 ${importer.name}`);
    console.log(`   ${importer.description}`);
    console.log('='.repeat(60));

    const child = spawn('node', [scriptPath, ...importerArgs], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${importer.name} exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

/**
 * Main function
 */
async function runAllImports() {
  console.log('🏛️  CMS Data Import (All Sources)');
  console.log('===================================\n');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No changes will be made to the database\n');
  }

  console.log('Available CMS data sources:');
  for (const importer of IMPORTERS) {
    console.log(`   ✓ ${importer.name}: ${importer.description}`);
  }

  const results = {
    success: [],
    failed: [],
  };

  for (const importer of IMPORTERS) {
    try {
      await runImporter(importer);
      results.success.push(importer.name);
    } catch (error) {
      console.error(`\n❌ ${importer.name} failed: ${error.message}`);
      results.failed.push(importer.name);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 CMS IMPORT SUMMARY');
  console.log('='.repeat(60));
  console.log(`Successful: ${results.success.length}`);
  for (const name of results.success) {
    console.log(`   ✓ ${name}`);
  }

  if (results.failed.length > 0) {
    console.log(`Failed: ${results.failed.length}`);
    for (const name of results.failed) {
      console.log(`   ✗ ${name}`);
    }
  }

  console.log('');
}

runAllImports().catch(error => {
  console.error('\n❌ Fatal error:', error.message);
  process.exit(1);
});
