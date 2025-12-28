/**
 * TPA Classification Script
 *
 * Analyzes TPAs in the database to determine if they are healthcare-focused.
 * Uses website scraping and keyword analysis to classify each TPA.
 *
 * Usage:
 *   npm run classify:tpas              # Classify all unclassified TPAs
 *   npm run classify:tpas -- --dry-run # Preview without updating database
 *   npm run classify:tpas -- --all     # Re-classify all TPAs (including already classified)
 *   npm run classify:tpas -- --id 123  # Classify a specific TPA by ID
 *
 * Output:
 *   - Updates is_healthcare_focused in tpas table
 *   - Stores found keywords in healthcare_keywords_found
 *   - Prints list of TPAs needing manual review
 */

import tpaIdentifier from '../scrapers/tpa-identifier.js';
import db from '../db/index.js';

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CLASSIFY_ALL = args.includes('--all');
const SPECIFIC_ID_INDEX = args.indexOf('--id');
const SPECIFIC_ID = SPECIFIC_ID_INDEX !== -1 ? parseInt(args[SPECIFIC_ID_INDEX + 1], 10) : null;

// Statistics
const stats = {
  total: 0,
  healthcareFocused: 0,
  notHealthcareFocused: 0,
  unknown: 0,
  needsReview: [],
  errors: [],
};

/**
 * Get TPAs to classify
 */
async function getTPAsToClassify() {
  let query;
  let params = [];

  if (SPECIFIC_ID) {
    query = 'SELECT id, name, website FROM tpas WHERE id = $1';
    params = [SPECIFIC_ID];
  } else if (CLASSIFY_ALL) {
    query = 'SELECT id, name, website FROM tpas ORDER BY name';
  } else {
    // Only unclassified TPAs
    query = 'SELECT id, name, website FROM tpas WHERE is_healthcare_focused IS NULL ORDER BY name';
  }

  try {
    return await db.queryAll(query, params);
  } catch (error) {
    console.log('⚠️  Could not load TPAs (database may not be set up)');
    return [];
  }
}

/**
 * Update TPA classification in database
 */
async function updateTPA(id, isHealthcareFocused, keywords) {
  await db.query(`
    UPDATE tpas SET
      is_healthcare_focused = $2,
      healthcare_keywords_found = $3,
      updated_at = NOW()
    WHERE id = $1
  `, [
    id,
    isHealthcareFocused,
    keywords,
  ]);
}

/**
 * Process a single TPA
 */
async function processTPA(tpa) {
  console.log(`\n📋 ${tpa.name}`);

  // First, quick check of company name
  const nameAnalysis = tpaIdentifier.analyzeCompanyName(tpa.name);

  if (nameAnalysis.suggestsNonHealthcare) {
    console.log(`   Name suggests non-healthcare: ${nameAnalysis.nonHealthcareKeywords.join(', ')}`);
  } else if (nameAnalysis.suggestsHealthcare) {
    console.log(`   Name suggests healthcare: ${nameAnalysis.healthcareKeywords.join(', ')}`);
  }

  // If no website, use name analysis only
  if (!tpa.website) {
    console.log(`   ⚠️ No website - using name analysis only`);

    const result = {
      isHealthcareFocused: nameAnalysis.suggestsHealthcare ? true : null,
      needsReview: !nameAnalysis.suggestsHealthcare && !nameAnalysis.suggestsNonHealthcare,
      keywords: nameAnalysis.healthcareKeywords,
    };

    if (result.needsReview) {
      stats.needsReview.push({
        id: tpa.id,
        name: tpa.name,
        reason: 'No website, unclear from name',
      });
      stats.unknown++;
    } else if (result.isHealthcareFocused) {
      stats.healthcareFocused++;
    } else {
      stats.notHealthcareFocused++;
    }

    if (!DRY_RUN && result.isHealthcareFocused !== null) {
      await updateTPA(tpa.id, result.isHealthcareFocused, result.keywords);
    }

    return result;
  }

  // Analyze website
  console.log(`   🌐 Analyzing website: ${tpa.website}`);

  try {
    const result = await tpaIdentifier.analyzeCompany(tpa.website, tpa.name);

    // Log result
    console.log(`   ${tpaIdentifier.formatResult(result)}`);

    // Update statistics
    if (result.isHealthcareFocused === true) {
      stats.healthcareFocused++;
    } else if (result.isHealthcareFocused === false) {
      stats.notHealthcareFocused++;
    } else {
      stats.unknown++;
    }

    if (result.needsReview) {
      stats.needsReview.push({
        id: tpa.id,
        name: tpa.name,
        website: tpa.website,
        reason: result.error || 'Ambiguous classification',
        strongKeywords: result.strongKeywordsFound.length,
        weakKeywords: result.weakKeywordsFound.length,
        nonHealthcareKeywords: result.nonHealthcareKeywordsFound.length,
      });
    }

    // Update database
    if (!DRY_RUN) {
      const keywords = tpaIdentifier.getAllHealthcareKeywords(result);
      await updateTPA(tpa.id, result.isHealthcareFocused, keywords);
    }

    return result;

  } catch (error) {
    console.log(`   ❌ Error: ${error.message}`);
    stats.errors.push({ id: tpa.id, name: tpa.name, error: error.message });
    stats.unknown++;

    stats.needsReview.push({
      id: tpa.id,
      name: tpa.name,
      website: tpa.website,
      reason: `Error: ${error.message}`,
    });

    return null;
  }
}

/**
 * Main function
 */
async function runClassification() {
  console.log('🏥 TPA Healthcare Classification');
  console.log('=================================\n');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No changes will be made to the database\n');
  }

  if (CLASSIFY_ALL) {
    console.log('📋 Mode: Classifying ALL TPAs (including already classified)\n');
  } else if (SPECIFIC_ID) {
    console.log(`📋 Mode: Classifying specific TPA ID: ${SPECIFIC_ID}\n`);
  } else {
    console.log('📋 Mode: Classifying only unclassified TPAs\n');
  }

  // Test database connection
  console.log('📦 Connecting to database...');
  const dbConnected = await db.testConnection();

  if (!dbConnected) {
    console.error('❌ Cannot connect to database. Run migrations first: npm run migrate');
    process.exit(1);
  }

  // Get TPAs to classify
  const tpas = await getTPAsToClassify();
  stats.total = tpas.length;

  if (tpas.length === 0) {
    console.log('\n✅ No TPAs to classify.');
    if (!CLASSIFY_ALL && !SPECIFIC_ID) {
      console.log('   Use --all to re-classify all TPAs.');
    }
    return;
  }

  console.log(`\n📊 Found ${tpas.length} TPAs to classify\n`);
  console.log('Rate limiting: 2 seconds between website requests');
  console.log('This may take a while for large datasets...\n');

  // Process each TPA
  for (let i = 0; i < tpas.length; i++) {
    const tpa = tpas[i];
    const progress = `[${i + 1}/${tpas.length}]`;

    console.log(`\n${progress} Processing: ${tpa.name}`);

    await processTPA(tpa);

    // Progress update every 10 TPAs
    if ((i + 1) % 10 === 0) {
      console.log(`\n   --- Progress: ${i + 1}/${tpas.length} (${Math.round((i + 1) / tpas.length * 100)}%) ---`);
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 CLASSIFICATION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total TPAs processed:     ${stats.total}`);
  console.log(`Healthcare-focused:       ${stats.healthcareFocused}`);
  console.log(`Not healthcare-focused:   ${stats.notHealthcareFocused}`);
  console.log(`Unknown/Unclassified:     ${stats.unknown}`);
  console.log(`Errors:                   ${stats.errors.length}`);

  // Print needs review list
  if (stats.needsReview.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('📝 NEEDS MANUAL REVIEW');
    console.log('='.repeat(60));

    for (const item of stats.needsReview) {
      console.log(`\nID: ${item.id}`);
      console.log(`   Name: ${item.name}`);
      if (item.website) {
        console.log(`   Website: ${item.website}`);
      }
      console.log(`   Reason: ${item.reason}`);
      if (item.strongKeywords !== undefined) {
        console.log(`   Keywords: ${item.strongKeywords} strong, ${item.weakKeywords} weak, ${item.nonHealthcareKeywords} non-HC`);
      }
    }

    console.log(`\n📋 Total needing review: ${stats.needsReview.length}`);
  }

  // Print errors
  if (stats.errors.length > 0) {
    console.log('\n❌ Errors:');
    for (const error of stats.errors.slice(0, 10)) {
      console.log(`   - ${error.name}: ${error.error}`);
    }
    if (stats.errors.length > 10) {
      console.log(`   ... and ${stats.errors.length - 10} more`);
    }
  }

  if (DRY_RUN) {
    console.log('\n⚠️  This was a dry run. No changes were made.');
    console.log('   Run without --dry-run to actually update the database.');
  }

  console.log('');
}

// Run classification
runClassification()
  .catch(error => {
    console.error('\n❌ Fatal error:', error.message);
    process.exit(1);
  })
  .finally(() => {
    db.closePool();
  });
