/**
 * Apollo.io Import Script - Companies Only
 *
 * Imports healthcare payer and TPA companies from Apollo.io API.
 * Skips companies that already exist in the database (saves API credits).
 *
 * Usage:
 *   npm run import:apollo              # Import new companies only (skip existing)
 *   npm run import:apollo -- --force   # Re-import all (update existing)
 *   npm run import:apollo -- --dry-run # Preview only, no database changes
 *   npm run import:apollo -- --query "company name" # Search specific company
 */

import config from '../config/index.js';
import apollo from '../services/apollo.js';
import db from '../db/index.js';
import fuzzy from '../utils/fuzzy-match.js';

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE_UPDATE = args.includes('--force');
const QUERY_INDEX = args.indexOf('--query');
const SPECIFIC_QUERY = QUERY_INDEX !== -1 ? args[QUERY_INDEX + 1] : null;

// Match threshold for fuzzy matching (0.85 = 85% similarity)
const FUZZY_MATCH_THRESHOLD = 0.85;

// Import statistics
const stats = {
  companiesFromApollo: 0,
  alreadyExist: 0,
  newPayersAdded: 0,
  newTpasAdded: 0,
  payersUpdated: 0,
  tpasUpdated: 0,
  errors: [],
};

/**
 * Load existing companies from database for deduplication
 * Includes name and website/domain for matching
 */
async function loadExistingCompanies() {
  const existing = {
    payers: [],
    tpas: [],
    domains: new Set(),
    normalizedNames: new Map(),
  };

  try {
    // Load payers
    const payers = await db.queryAll(`
      SELECT id, name, website, apollo_id
      FROM payers
    `);
    existing.payers = payers;

    // Load TPAs
    const tpas = await db.queryAll(`
      SELECT id, name, website, apollo_id
      FROM tpas
    `);
    existing.tpas = tpas;

    // Build domain lookup set
    for (const p of payers) {
      if (p.website) {
        const domain = extractDomain(p.website);
        if (domain) existing.domains.add(domain.toLowerCase());
      }
      // Add normalized name to map
      const normalized = fuzzy.normalizeName(p.name);
      existing.normalizedNames.set(normalized, { type: 'payer', id: p.id, name: p.name });
    }

    for (const t of tpas) {
      if (t.website) {
        const domain = extractDomain(t.website);
        if (domain) existing.domains.add(domain.toLowerCase());
      }
      const normalized = fuzzy.normalizeName(t.name);
      existing.normalizedNames.set(normalized, { type: 'tpa', id: t.id, name: t.name });
    }

    console.log(`   Loaded ${payers.length} payers, ${tpas.length} TPAs`);
    console.log(`   Known domains: ${existing.domains.size}`);

  } catch (error) {
    console.log('⚠️  Could not load existing companies (database may not be set up)');
  }

  return existing;
}

/**
 * Extract domain from URL
 */
function extractDomain(url) {
  if (!url) return null;
  try {
    // Handle URLs without protocol
    if (!url.startsWith('http')) {
      url = 'https://' + url;
    }
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, '');
  } catch {
    // If URL parsing fails, try basic extraction
    return url.replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  }
}

/**
 * Check if a company already exists in our database
 * Returns { exists: boolean, match?: object }
 */
function companyExists(apolloCompany, existingData) {
  // 1. Check Apollo ID match
  const apolloId = apolloCompany.apolloId;
  if (apolloId) {
    const payerMatch = existingData.payers.find(p => p.apollo_id === apolloId);
    if (payerMatch) return { exists: true, match: payerMatch, type: 'payer', reason: 'apollo_id' };

    const tpaMatch = existingData.tpas.find(t => t.apollo_id === apolloId);
    if (tpaMatch) return { exists: true, match: tpaMatch, type: 'tpa', reason: 'apollo_id' };
  }

  // 2. Check domain match
  const companyDomain = extractDomain(apolloCompany.website);
  if (companyDomain && existingData.domains.has(companyDomain.toLowerCase())) {
    return { exists: true, reason: 'domain' };
  }

  // 3. Check exact normalized name match
  const normalizedName = fuzzy.normalizeName(apolloCompany.name);
  if (existingData.normalizedNames.has(normalizedName)) {
    const match = existingData.normalizedNames.get(normalizedName);
    return { exists: true, match, type: match.type, reason: 'exact_name' };
  }

  // 4. Fuzzy name match (>85% similarity)
  const allCompanies = [...existingData.payers, ...existingData.tpas];
  const fuzzyMatch = fuzzy.findBestMatch(apolloCompany.name, allCompanies);

  if (fuzzyMatch && fuzzyMatch.score <= (1 - FUZZY_MATCH_THRESHOLD)) {
    // Fuse.js score: 0 = perfect match, 1 = no match
    // So score <= 0.15 means >= 85% match
    return {
      exists: true,
      match: fuzzyMatch.match,
      reason: 'fuzzy_name',
      similarity: Math.round((1 - fuzzyMatch.score) * 100) + '%'
    };
  }

  return { exists: false };
}

/**
 * Insert a new payer into the database
 */
async function insertPayer(company) {
  const result = await db.query(`
    INSERT INTO payers (
      name, parent_company, type, states, employee_count,
      website, linkedin_url, apollo_id, data_sources
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
  `, [
    company.name,
    company.parentCompany,
    company.type,
    company.states,
    company.employeeCount,
    company.website,
    company.linkedinUrl,
    company.apolloId,
    ['Apollo'],
  ]);

  return result.rows[0]?.id;
}

/**
 * Update an existing payer
 */
async function updatePayer(id, company) {
  await db.query(`
    UPDATE payers SET
      website = COALESCE(website, $2),
      linkedin_url = COALESCE(linkedin_url, $3),
      apollo_id = COALESCE(apollo_id, $4),
      employee_count = COALESCE(employee_count, $5),
      states = CASE WHEN states = '{}' THEN $6 ELSE states END,
      data_sources = CASE
        WHEN NOT ('Apollo' = ANY(data_sources))
        THEN array_append(data_sources, 'Apollo')
        ELSE data_sources
      END,
      updated_at = NOW()
    WHERE id = $1
  `, [
    id,
    company.website,
    company.linkedinUrl,
    company.apolloId,
    company.employeeCount,
    company.states,
  ]);
}

/**
 * Insert a new TPA into the database
 */
async function insertTPA(company, tpaInfo) {
  const result = await db.query(`
    INSERT INTO tpas (
      name, parent_company, type, states, employee_count,
      website, linkedin_url, apollo_id, data_sources,
      is_healthcare_focused, healthcare_keywords_found
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
  `, [
    company.name,
    company.parentCompany,
    company.type,
    company.states,
    company.employeeCount,
    company.website,
    company.linkedinUrl,
    company.apolloId,
    ['Apollo'],
    tpaInfo.isHealthcareFocused,
    tpaInfo.healthcareKeywords,
  ]);

  return result.rows[0]?.id;
}

/**
 * Update an existing TPA
 */
async function updateTPA(id, company, tpaInfo) {
  await db.query(`
    UPDATE tpas SET
      website = COALESCE(website, $2),
      linkedin_url = COALESCE(linkedin_url, $3),
      apollo_id = COALESCE(apollo_id, $4),
      employee_count = COALESCE(employee_count, $5),
      is_healthcare_focused = COALESCE(is_healthcare_focused, $6),
      data_sources = CASE
        WHEN NOT ('Apollo' = ANY(data_sources))
        THEN array_append(data_sources, 'Apollo')
        ELSE data_sources
      END,
      updated_at = NOW()
    WHERE id = $1
  `, [
    id,
    company.website,
    company.linkedinUrl,
    company.apolloId,
    company.employeeCount,
    tpaInfo.isHealthcareFocused,
  ]);
}

/**
 * Process a single company from Apollo
 */
async function processCompany(company, existingData) {
  const tpaInfo = apollo.checkIfTPA(company);
  const isTPA = tpaInfo.isTPA;

  // Check if company already exists
  const existCheck = companyExists(company, existingData);

  if (existCheck.exists && !FORCE_UPDATE) {
    stats.alreadyExist++;
    if (DRY_RUN) {
      console.log(`   [SKIP] ${company.name} (${existCheck.reason}${existCheck.similarity ? ': ' + existCheck.similarity : ''})`);
    }
    return null;
  }

  if (DRY_RUN) {
    const action = existCheck.exists ? 'UPDATE' : 'ADD';
    const type = isTPA ? 'TPA' : 'Payer';
    console.log(`   [${action}] ${type}: ${company.name}`);
    return null;
  }

  try {
    if (existCheck.exists && FORCE_UPDATE && existCheck.match) {
      // Update existing record
      if (isTPA) {
        await updateTPA(existCheck.match.id, company, tpaInfo);
        stats.tpasUpdated++;
      } else {
        await updatePayer(existCheck.match.id, company);
        stats.payersUpdated++;
      }
      return existCheck.match.id;
    } else {
      // Insert new record
      if (isTPA) {
        const id = await insertTPA(company, tpaInfo);
        stats.newTpasAdded++;
        return id;
      } else {
        const id = await insertPayer(company);
        stats.newPayersAdded++;
        return id;
      }
    }
  } catch (error) {
    stats.errors.push(`${company.name}: ${error.message}`);
    console.error(`   ❌ Error processing ${company.name}: ${error.message}`);
    return null;
  }
}

/**
 * Run a single search query
 */
async function runSearchQuery(query) {
  console.log(`\n📋 Query: ${query.name} ("${query.query}")`);

  const companies = await apollo.searchCompanies({
    query: query.query,
    maxPages: 3, // 3 pages x 100 results = 300 per query
  });

  return companies;
}

/**
 * Main import function
 */
async function runImport() {
  console.log('🚀 APOLLO.IO IMPORT (Companies Only)');
  console.log('=====================================\n');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No changes will be made\n');
  }

  if (FORCE_UPDATE) {
    console.log('⚠️  FORCE MODE - Will update existing companies\n');
  } else {
    console.log('📋 Mode: Skip existing companies (saves API credits)\n');
  }

  // Check Apollo API key
  if (!config.apollo.hasApiKey) {
    console.error('❌ APOLLO_API_KEY is not configured.');
    console.log('\n   To use Apollo import:');
    console.log('   1. Sign up at https://www.apollo.io/');
    console.log('   2. Get your API key from Settings > API');
    console.log('   3. Add APOLLO_API_KEY to Railway environment variables\n');
    process.exit(1);
  }

  // Test Apollo API connection
  console.log('🔌 Testing Apollo API connection...');
  const connectionTest = await apollo.testConnection();

  if (!connectionTest.success) {
    console.error(`❌ Apollo API connection failed: ${connectionTest.message}`);
    if (connectionTest.details) {
      console.error(`   Details: ${JSON.stringify(connectionTest.details)}`);
    }
    process.exit(1);
  }

  console.log(`✅ ${connectionTest.message}`);
  if (connectionTest.details) {
    console.log(`   Test query returned ${connectionTest.details.organizationsInTest} of ${connectionTest.details.totalAvailable} available`);
  }

  // Test database connection
  console.log('📦 Connecting to database...');
  const dbConnected = await db.testConnection();

  if (!dbConnected && !DRY_RUN) {
    console.error('❌ Cannot connect to database. Run migrations first.');
    process.exit(1);
  }

  // Load existing companies for deduplication
  console.log('\n📊 Loading existing companies for deduplication...');
  const existingData = await loadExistingCompanies();

  let allCompanies = [];

  // Handle specific query mode
  if (SPECIFIC_QUERY) {
    console.log(`\n🔍 Searching for: "${SPECIFIC_QUERY}"`);
    allCompanies = await apollo.searchCompanyByQuery(SPECIFIC_QUERY);
  } else {
    // Run all healthcare queries
    for (const query of apollo.HEALTHCARE_QUERIES) {
      const companies = await runSearchQuery(query);
      allCompanies.push(...companies);
    }

    // Deduplicate by Apollo ID
    const uniqueCompanies = new Map();
    for (const company of allCompanies) {
      if (company.apolloId && !uniqueCompanies.has(company.apolloId)) {
        uniqueCompanies.set(company.apolloId, company);
      } else if (!company.apolloId) {
        const key = fuzzy.normalizeName(company.name);
        if (!uniqueCompanies.has(key)) {
          uniqueCompanies.set(key, company);
        }
      }
    }
    allCompanies = Array.from(uniqueCompanies.values());
  }

  stats.companiesFromApollo = allCompanies.length;
  console.log(`\n📊 Found ${allCompanies.length} companies from Apollo\n`);

  // Process each company
  console.log('Processing companies...\n');

  for (let i = 0; i < allCompanies.length; i++) {
    const company = allCompanies[i];
    const progress = `[${i + 1}/${allCompanies.length}]`;

    if (!DRY_RUN) {
      console.log(`${progress} ${company.name}`);
    }

    await processCompany(company, existingData);
  }

  // Log import to database
  if (!DRY_RUN && dbConnected) {
    try {
      await db.query(`
        INSERT INTO import_logs (source, records_found, records_added, records_updated, errors, completed_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [
        'Apollo',
        stats.companiesFromApollo,
        stats.newPayersAdded + stats.newTpasAdded,
        stats.payersUpdated + stats.tpasUpdated,
        stats.errors.slice(0, 10),
      ]);
    } catch {
      // import_logs table might not exist
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 APOLLO IMPORT SUMMARY');
  console.log('='.repeat(50));
  console.log(`Companies found in Apollo:  ${stats.companiesFromApollo}`);
  console.log(`Already in database:        ${stats.alreadyExist} (skipped)`);
  console.log(`New payers added:           ${stats.newPayersAdded}`);
  console.log(`New TPAs added:             ${stats.newTpasAdded}`);

  if (FORCE_UPDATE) {
    console.log(`Payers updated:             ${stats.payersUpdated}`);
    console.log(`TPAs updated:               ${stats.tpasUpdated}`);
  }

  console.log(`Errors:                     ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log('\n❌ Errors:');
    for (const error of stats.errors.slice(0, 5)) {
      console.log(`   - ${error}`);
    }
    if (stats.errors.length > 5) {
      console.log(`   ... and ${stats.errors.length - 5} more`);
    }
  }

  if (DRY_RUN) {
    console.log('\n⚠️  This was a dry run. No changes were made.');
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
