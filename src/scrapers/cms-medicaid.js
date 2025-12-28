/**
 * CMS Medicaid MCO Data Scraper
 *
 * Downloads and parses Medicaid Managed Care enrollment data from CMS.
 * This includes state Medicaid MCO (Managed Care Organization) enrollment.
 *
 * Data Sources:
 * - Data.Medicaid.gov API
 *   https://data.medicaid.gov/dataset/0bef7b8a-c663-5b14-9a46-0b5c2b86b0fe
 *
 * - Medicaid Managed Care Enrollment Report
 *   https://www.medicaid.gov/medicaid/managed-care/enrollment-report
 *
 * Plan Types:
 * - MCO: Managed Care Organization (comprehensive)
 * - PIHP: Prepaid Inpatient Health Plan
 * - PAHP: Prepaid Ambulatory Health Plan
 * - PCCM: Primary Care Case Management
 * - MLTSS: Managed Long-Term Services and Supports
 * - BHO: Behavioral Health Organization
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../config/index.js';

// Get directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Data directory for downloaded files
const DATA_DIR = path.join(__dirname, '../../data/cms');

// Data.Medicaid.gov API endpoints
const MEDICAID_API_BASE = 'https://data.medicaid.gov/api/1';

// Dataset UUIDs from data.medicaid.gov
const DATASETS = {
  // Managed Care Enrollment by Program and Plan
  enrollmentByPlan: '0bef7b8a-c663-5b14-9a46-0b5c2b86b0fe',
  // Managed Care Enrollment Summary
  enrollmentSummary: '52ed908b-0cb8-5dd2-846d-99d4af12b369',
  // Managed Care Programs by State
  programsByState: '0e112ea8-8e8e-5dee-a7e2-7ed551c3baa4',
};

// Known parent company mappings for Medicaid MCOs
const PARENT_COMPANY_MAP = {
  // Elevance Health (formerly Anthem) brands
  'amerigroup': 'Elevance Health',
  'anthem': 'Elevance Health',
  'healthplus': 'Elevance Health',
  'simply healthcare': 'Elevance Health',

  // Centene brands
  'centene': 'Centene',
  'wellcare': 'Centene',
  'ambetter': 'Centene',
  'peach state': 'Centene',
  'buckeye': 'Centene',
  'sunshine health': 'Centene',
  'superior healthplan': 'Centene',
  'magnolia health': 'Centene',
  'coordinated care': 'Centene',
  'fidelis': 'Centene',
  'home state health': 'Centene',
  'illinicare': 'Centene',
  'louisiana healthcare': 'Centene',
  'managed health services': 'Centene',
  'nebraska total care': 'Centene',
  'peach state health': 'Centene',
  'sunflower': 'Centene',
  'trillium': 'Centene',
  'western sky': 'Centene',

  // UnitedHealth Group brands
  'unitedhealthcare': 'UnitedHealth Group',
  'united healthcare': 'UnitedHealth Group',
  'uhc': 'UnitedHealth Group',
  'optum': 'UnitedHealth Group',
  'americhoice': 'UnitedHealth Group',

  // Molina brands
  'molina': 'Molina Healthcare',

  // CVS/Aetna brands
  'aetna': 'CVS Health',

  // Humana brands
  'humana': 'Humana',

  // Cigna brands
  'cigna': 'Cigna',
  'evernorth': 'Cigna',

  // BCBS affiliates (varies by state)
  'blue cross': 'Blue Cross Blue Shield',
  'blue shield': 'Blue Cross Blue Shield',
  'bcbs': 'Blue Cross Blue Shield',
  'anthem blue cross': 'Elevance Health',

  // Kaiser
  'kaiser': 'Kaiser Permanente',

  // Other major MCOs
  'caresource': 'CareSource',
  'community health plan': null, // Often state-specific
  'health net': 'Health Net',
  'la care': 'L.A. Care Health Plan',
  'health first': 'Health First',
};

/**
 * Ensure the data directory exists
 */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Detect parent company from MCO name
 * @param {string} name - MCO name
 * @returns {string|null} Parent company name or null
 */
export function detectParentCompany(name) {
  if (!name) return null;

  const lowerName = name.toLowerCase();

  for (const [keyword, parent] of Object.entries(PARENT_COMPANY_MAP)) {
    if (lowerName.includes(keyword)) {
      return parent;
    }
  }

  return null;
}

/**
 * Extract state abbreviation from MCO name if present
 * Example: "Amerigroup Texas" -> "TX"
 */
const STATE_NAMES = {
  'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR',
  'california': 'CA', 'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE',
  'florida': 'FL', 'georgia': 'GA', 'hawaii': 'HI', 'idaho': 'ID',
  'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA', 'kansas': 'KS',
  'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
  'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS',
  'missouri': 'MO', 'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH', 'oklahoma': 'OK',
  'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT',
  'vermont': 'VT', 'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV',
  'wisconsin': 'WI', 'wyoming': 'WY', 'district of columbia': 'DC',
  'puerto rico': 'PR', 'guam': 'GU', 'virgin islands': 'VI',
};

/**
 * Fetch data from Data.Medicaid.gov API
 * @param {string} datasetId - Dataset UUID
 * @param {object} options - Query options
 * @returns {Promise<object[]>} Array of records
 */
async function fetchMedicaidData(datasetId, options = {}) {
  const limit = options.limit || 1000;
  const offset = options.offset || 0;

  // Try the datastore query endpoint
  const url = `${MEDICAID_API_BASE}/datastore/query/${datasetId}/0`;

  console.log(`🌐 Fetching Medicaid data (limit: ${limit}, offset: ${offset})...`);

  try {
    const response = await axios.get(url, {
      params: {
        limit,
        offset,
        ...options.filters,
      },
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 60000,
    });

    const data = response.data;

    // Handle different response formats
    if (Array.isArray(data)) {
      console.log(`   ✅ Fetched ${data.length} records`);
      return data;
    } else if (data.results) {
      console.log(`   ✅ Fetched ${data.results.length} records`);
      return data.results;
    } else if (data.data) {
      console.log(`   ✅ Fetched ${data.data.length} records`);
      return data.data;
    }

    console.log(`   ⚠️ Unexpected response format`);
    return [];

  } catch (error) {
    if (error.response?.status === 403) {
      console.log(`   ⚠️ API access forbidden - trying CSV download...`);
      return fetchMedicaidCSV(datasetId);
    }
    console.error(`   ❌ API error: ${error.message}`);
    return [];
  }
}

/**
 * Fetch data as CSV download (fallback)
 * @param {string} datasetId - Dataset UUID
 * @returns {Promise<object[]>} Array of records
 */
async function fetchMedicaidCSV(datasetId) {
  const url = `${MEDICAID_API_BASE}/datastore/query/${datasetId}/0/download`;

  console.log(`   📥 Downloading CSV...`);

  try {
    const response = await axios.get(url, {
      params: { format: 'csv' },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 120000,
    });

    // Parse CSV
    const lines = response.data.trim().split('\n');
    if (lines.length < 2) return [];

    const headers = parseCSVLine(lines[0]);
    const records = [];

    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      const record = {};

      for (let j = 0; j < headers.length; j++) {
        record[headers[j]] = values[j] || '';
      }

      records.push(record);
    }

    // Save to file for inspection
    ensureDataDir();
    const filename = `medicaid-mco-${new Date().toISOString().slice(0, 10)}.csv`;
    fs.writeFileSync(path.join(DATA_DIR, filename), response.data);

    console.log(`   ✅ Downloaded ${records.length} records`);
    return records;

  } catch (error) {
    console.error(`   ❌ CSV download failed: ${error.message}`);
    return [];
  }
}

/**
 * Parse a CSV line handling quoted values
 */
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

/**
 * Normalize Medicaid MCO data to our format
 * @param {object[]} rawData - Raw API/CSV data
 * @returns {object[]} Normalized MCO data
 */
function normalizeMCOData(rawData) {
  console.log('   🔄 Normalizing MCO data...');

  // Group by plan/MCO name
  const mcoMap = new Map();

  for (const row of rawData) {
    // Handle different column name variations
    const planName = row['plan_name'] || row['Plan Name'] || row['managed_care_plan_name'] ||
                     row['Managed Care Plan Name'] || row['mco_name'] || '';
    const state = row['state'] || row['State'] || row['state_code'] || '';
    const enrollment = parseInt(
      row['enrollment'] || row['Enrollment'] || row['total_enrollment'] ||
      row['Total Enrollment'] || row['enrollees'] || '0', 10
    ) || 0;
    const planType = row['plan_type'] || row['Plan Type'] || row['program_type'] ||
                     row['Program Type'] || row['managed_care_program_type'] || 'MCO';
    const reportYear = row['report_year'] || row['Report Year'] || row['year'] || '';

    if (!planName || enrollment === 0) continue;

    // Create key for grouping (normalize name)
    const normalizedName = planName.trim().toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/,?\s*(inc\.?|llc|corp\.?|corporation)$/i, '');

    if (!mcoMap.has(normalizedName)) {
      mcoMap.set(normalizedName, {
        name: planName.trim(),
        states: new Set(),
        totalEnrollment: 0,
        planTypes: new Set(),
        parentCompany: detectParentCompany(planName),
        reportYear: reportYear,
      });
    }

    const mco = mcoMap.get(normalizedName);
    if (state) mco.states.add(state);
    mco.totalEnrollment += enrollment;
    if (planType) mco.planTypes.add(planType);
  }

  // Convert to array
  const mcos = Array.from(mcoMap.values()).map(mco => ({
    name: mco.name,
    parentCompany: mco.parentCompany,
    states: Array.from(mco.states),
    memberCount: mco.totalEnrollment,
    planTypes: Array.from(mco.planTypes),
    type: 'MCO',
    dataSources: ['CMS'],
    reportYear: mco.reportYear,
  }));

  // Sort by enrollment descending
  mcos.sort((a, b) => b.memberCount - a.memberCount);

  console.log(`   📊 Normalized to ${mcos.length} MCOs`);
  console.log(`   📊 Total enrollment: ${mcos.reduce((sum, m) => sum + m.memberCount, 0).toLocaleString()}`);

  return mcos;
}

// ============================================
// MAIN EXPORT FUNCTIONS
// ============================================

/**
 * Get the latest Medicaid MCO enrollment data
 * @returns {Promise<object[]>} Array of normalized MCO data
 */
export async function getLatestMCOData() {
  console.log('\n📋 Fetching Medicaid MCO enrollment data...');

  // Try the enrollment by plan dataset first
  let rawData = await fetchMedicaidData(DATASETS.enrollmentByPlan);

  if (rawData.length === 0) {
    // Try the summary dataset as fallback
    console.log('   Trying enrollment summary dataset...');
    rawData = await fetchMedicaidData(DATASETS.enrollmentSummary);
  }

  if (rawData.length === 0) {
    console.log('   ⚠️ Could not fetch Medicaid data from API');
    console.log('   Try downloading manually from:');
    console.log('   https://data.medicaid.gov/dataset/0bef7b8a-c663-5b14-9a46-0b5c2b86b0fe');
    return [];
  }

  return normalizeMCOData(rawData);
}

/**
 * Get Medicaid programs by state
 * @returns {Promise<object[]>} Array of state program data
 */
export async function getProgramsByState() {
  console.log('\n📋 Fetching Medicaid programs by state...');

  const rawData = await fetchMedicaidData(DATASETS.programsByState);

  if (rawData.length === 0) {
    console.log('   ⚠️ Could not fetch state program data');
    return [];
  }

  return rawData;
}

/**
 * Get data directory path
 */
export function getDataDir() {
  ensureDataDir();
  return DATA_DIR;
}

/**
 * List downloaded files
 */
export function listDownloadedFiles() {
  ensureDataDir();
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.includes('medicaid'))
    .map(file => ({
      name: file,
      path: path.join(DATA_DIR, file),
      size: fs.statSync(path.join(DATA_DIR, file)).size,
    }));
}

export default {
  getLatestMCOData,
  getProgramsByState,
  detectParentCompany,
  getDataDir,
  listDownloadedFiles,
  DATASETS,
};
