/**
 * Apollo.io Import Script
 *
 * Imports healthcare payer and TPA data from Apollo.io API.
 *
 * Usage:
 *   npm run import:apollo              # Full import
 *   npm run import:apollo -- --dry-run # Preview only, no database changes
 *   npm run import:apollo -- --contacts-only # Just refresh contacts
 *   npm run import:apollo -- --query "company name" # Search specific company
 *
 * What this does:
 * 1. Searches Apollo for healthcare payers and TPAs
 * 2. Checks each company against our database (fuzzy matching)
 * 3. Inserts new companies or updates existing ones
 * 4. Separates TPAs from health plans
 * 5. Optionally pulls contacts for good prospects
 */

import config from '../config/index.js';
import apollo from '../services/apollo.js';
import db from '../db/index.js';
import fuzzy from '../utils/fuzzy-match.js';

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CONTACTS_ONLY = args.includes('--contacts-only');
const QUERY_INDEX = args.indexOf('--query');
const SPECIFIC_QUERY = QUERY_INDEX !== -1 ? args[QUERY_INDEX + 1] : null;

// Import statistics
const stats = {
  companiesFound: 0,
  payersAdded: 0,
  payersUpdated: 0,
  tpasAdded: 0,
  tpasUpdated: 0,
  contactsAdded: 0,
  errors: [],
};

/**
 * Get existing payers from database for deduplication
 */
async function getExistingPayers() {
  try {
    return await db.queryAll('SELECT id, name, apollo_id FROM payers');
  } catch (error) {
    console.log('⚠️  Could not load existing payers (database may not be set up)');
    return [];
  }
}

/**
 * Get existing TPAs from database for deduplication
 */
async function getExistingTPAs() {
  try {
    return await db.queryAll('SELECT id, name, apollo_id FROM tpas');
  } catch (error) {
    console.log('⚠️  Could not load existing TPAs (database may not be set up)');
    return [];
  }
}

/**
 * Insert a new payer into the database
 */
async function insertPayer(company) {
  const result = await db.query(`
    INSERT INTO payers (
      name, parent_company, type, states, employee_count,
      core_system, core_system_source, website, linkedin_url,
      apollo_id, data_sources
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id
  `, [
    company.name,
    company.parentCompany,
    company.type,
    company.states,
    company.employeeCount,
    company.coreSystem,
    company.coreSystemSource,
    company.website,
    company.linkedinUrl,
    company.apolloId,
    company.dataSources,
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
      states = CASE
        WHEN states = '{}' THEN $6
        ELSE states
      END,
      data_sources = array_cat(data_sources, $7),
      updated_at = NOW()
    WHERE id = $1
  `, [
    id,
    company.website,
    company.linkedinUrl,
    company.apolloId,
    company.employeeCount,
    company.states,
    ['Apollo'],
  ]);
}

/**
 * Insert a new TPA into the database
 */
async function insertTPA(company, tpaInfo) {
  const result = await db.query(`
    INSERT INTO tpas (
      name, parent_company, type, states, employee_count,
      core_system, core_system_source, website, linkedin_url,
      apollo_id, data_sources, is_healthcare_focused, healthcare_keywords_found
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING id
  `, [
    company.name,
    company.parentCompany,
    company.type,
    company.states,
    company.employeeCount,
    company.coreSystem,
    company.coreSystemSource,
    company.website,
    company.linkedinUrl,
    company.apolloId,
    company.dataSources,
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
      healthcare_keywords_found = array_cat(healthcare_keywords_found, $7),
      data_sources = array_cat(data_sources, $8),
      updated_at = NOW()
    WHERE id = $1
  `, [
    id,
    company.website,
    company.linkedinUrl,
    company.apolloId,
    company.employeeCount,
    tpaInfo.isHealthcareFocused,
    tpaInfo.healthcareKeywords,
    ['Apollo'],
  ]);
}

/**
 * Insert a contact into the database
 */
async function insertContact(contact, payerId, tpaId) {
  await db.query(`
    INSERT INTO contacts (payer_id, tpa_id, name, title, email, phone, linkedin_url, source)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT DO NOTHING
  `, [
    payerId,
    tpaId,
    contact.name,
    contact.title,
    contact.email,
    contact.phone,
    contact.linkedinUrl,
    contact.source,
  ]);
}

/**
 * Process a single company from Apollo
 */
async function processCompany(company, existingPayers, existingTPAs) {
  const tpaInfo = apollo.checkIfTPA(company);

  // Determine if this is a TPA or a payer
  const isTPA = tpaInfo.isTPA;

  // Find existing match
  const existingList = isTPA ? existingTPAs : existingPayers;
  const match = fuzzy.findBestMatch(company.name, existingList);

  // Check for Apollo ID match as well
  let apolloMatch = null;
  if (company.apolloId) {
    apolloMatch = existingList.find(e => e.apollo_id === company.apolloId);
  }

  const existingMatch = apolloMatch || match?.match;

  if (DRY_RUN) {
    const action = existingMatch ? 'UPDATE' : 'ADD';
    const type = isTPA ? 'TPA' : 'Payer';
    console.log(`   [${action}] ${type}: ${company.name}`);
    if (tpaInfo.healthcareKeywords.length) {
      console.log(`      Keywords: ${tpaInfo.healthcareKeywords.join(', ')}`);
    }
    return null;
  }

  try {
    let entityId;

    if (isTPA) {
      if (existingMatch) {
        await updateTPA(existingMatch.id, company, tpaInfo);
        stats.tpasUpdated++;
        entityId = existingMatch.id;
      } else {
        entityId = await insertTPA(company, tpaInfo);
        stats.tpasAdded++;
      }
    } else {
      if (existingMatch) {
        await updatePayer(existingMatch.id, company);
        stats.payersUpdated++;
        entityId = existingMatch.id;
      } else {
        entityId = await insertPayer(company);
        stats.payersAdded++;
      }
    }

    return { id: entityId, isTPA };

  } catch (error) {
    stats.errors.push(`${company.name}: ${error.message}`);
    console.error(`   ❌ Error processing ${company.name}: ${error.message}`);
    return null;
  }
}

/**
 * Import contacts for a company
 */
async function importContacts(companyId, companyName, payerId, tpaId) {
  try {
    const contacts = await apollo.getContacts(companyId, companyName);

    for (const contact of contacts) {
      if (DRY_RUN) {
        console.log(`      Contact: ${contact.name} - ${contact.title}`);
      } else {
        await insertContact(contact, payerId, tpaId);
        stats.contactsAdded++;
      }
    }

    return contacts.length;
  } catch (error) {
    console.error(`   ❌ Error getting contacts: ${error.message}`);
    return 0;
  }
}

/**
 * Run a single search query
 */
async function runSearchQuery(query) {
  console.log(`\n📋 Running query: ${query.name}`);
  console.log(`   Industry: ${query.industry || 'Any'}`);
  console.log(`   Keywords: ${query.keywords?.join(', ') || 'None'}`);

  const companies = await apollo.searchCompanies({
    industry: query.industry,
    keywords: query.keywords,
    maxPages: 5, // Limit per query to stay within API limits
  });

  return companies;
}

/**
 * Main import function
 */
async function runImport() {
  console.log('🚀 Apollo.io Import');
  console.log('===================\n');

  if (DRY_RUN) {
    console.log('⚠️  DRY RUN MODE - No changes will be made to the database\n');
  }

  if (CONTACTS_ONLY) {
    console.log('📇 CONTACTS ONLY MODE - Only refreshing contacts for existing companies\n');
  }

  // Check Apollo API key
  if (!config.apollo.hasApiKey) {
    console.error('❌ APOLLO_API_KEY is not configured.');
    console.log('\n   To use Apollo import:');
    console.log('   1. Sign up at https://www.apollo.io/');
    console.log('   2. Get your API key from Settings > API');
    console.log('   3. Add APOLLO_API_KEY to your .env file\n');
    process.exit(1);
  }

  // Test database connection
  console.log('📦 Connecting to database...');
  const dbConnected = await db.testConnection();

  if (!dbConnected && !DRY_RUN) {
    console.error('❌ Cannot connect to database. Run migrations first: npm run migrate');
    process.exit(1);
  }

  // Get existing data for deduplication
  const existingPayers = await getExistingPayers();
  const existingTPAs = await getExistingTPAs();
  console.log(`   Existing payers: ${existingPayers.length}`);
  console.log(`   Existing TPAs: ${existingTPAs.length}`);

  let allCompanies = [];

  // Handle specific query mode
  if (SPECIFIC_QUERY) {
    console.log(`\n🔍 Searching for: "${SPECIFIC_QUERY}"`);
    allCompanies = await apollo.searchCompanyByQuery(SPECIFIC_QUERY);
  }
  // Handle contacts-only mode
  else if (CONTACTS_ONLY) {
    // Get companies that have Apollo IDs but might need contact refresh
    const payersWithApollo = await db.queryAll(
      'SELECT id, name, apollo_id FROM payers WHERE apollo_id IS NOT NULL'
    );
    const tpasWithApollo = await db.queryAll(
      'SELECT id, name, apollo_id FROM tpas WHERE apollo_id IS NOT NULL'
    );

    console.log(`\n📇 Refreshing contacts for ${payersWithApollo.length} payers and ${tpasWithApollo.length} TPAs...`);

    for (const payer of payersWithApollo) {
      await importContacts(payer.apollo_id, payer.name, payer.id, null);
    }

    for (const tpa of tpasWithApollo) {
      await importContacts(tpa.apollo_id, tpa.name, null, tpa.id);
    }
  }
  // Full import mode
  else {
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
        // No Apollo ID, use name as key
        const key = fuzzy.normalizeName(company.name);
        if (!uniqueCompanies.has(key)) {
          uniqueCompanies.set(key, company);
        }
      }
    }

    allCompanies = Array.from(uniqueCompanies.values());
  }

  stats.companiesFound = allCompanies.length;
  console.log(`\n📊 Found ${allCompanies.length} unique companies to process\n`);

  // Process each company
  if (!CONTACTS_ONLY) {
    console.log('Processing companies...\n');

    for (let i = 0; i < allCompanies.length; i++) {
      const company = allCompanies[i];
      const progress = `[${i + 1}/${allCompanies.length}]`;

      console.log(`${progress} ${company.name}`);

      const result = await processCompany(company, existingPayers, existingTPAs);

      // For promising companies (50+ employees), also get contacts
      if (result && company.employeeCount >= 50) {
        const payerId = result.isTPA ? null : result.id;
        const tpaId = result.isTPA ? result.id : null;
        await importContacts(company.apolloId, company.name, payerId, tpaId);
      }
    }
  }

  // Log import to database
  if (!DRY_RUN && dbConnected) {
    try {
      await db.query(`
        INSERT INTO import_logs (source, records_found, records_added, records_updated, errors, completed_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `, [
        'Apollo',
        stats.companiesFound,
        stats.payersAdded + stats.tpasAdded,
        stats.payersUpdated + stats.tpasUpdated,
        stats.errors.slice(0, 10), // Limit errors stored
      ]);
    } catch (error) {
      console.log('⚠️  Could not log import (import_logs table may not exist)');
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 IMPORT SUMMARY');
  console.log('='.repeat(50));
  console.log(`Companies found:    ${stats.companiesFound}`);
  console.log(`Payers added:       ${stats.payersAdded}`);
  console.log(`Payers updated:     ${stats.payersUpdated}`);
  console.log(`TPAs added:         ${stats.tpasAdded}`);
  console.log(`TPAs updated:       ${stats.tpasUpdated}`);
  console.log(`Contacts added:     ${stats.contactsAdded}`);
  console.log(`Errors:             ${stats.errors.length}`);

  if (stats.errors.length > 0) {
    console.log('\n❌ Errors:');
    for (const error of stats.errors.slice(0, 10)) {
      console.log(`   - ${error}`);
    }
    if (stats.errors.length > 10) {
      console.log(`   ... and ${stats.errors.length - 10} more`);
    }
  }

  if (DRY_RUN) {
    console.log('\n⚠️  This was a dry run. No changes were made.');
    console.log('   Run without --dry-run to actually import data.');
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
