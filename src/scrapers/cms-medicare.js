/**
 * CMS Medicare Advantage Data Scraper
 *
 * Downloads and parses Medicare Advantage enrollment data from CMS.
 * This is OFFICIAL government data on MA plan enrollment.
 *
 * Data Sources:
 * - Monthly Enrollment by Contract/Plan/State/County (CPSC)
 *   https://www.cms.gov/data-research/statistics-trends-and-reports/medicare-advantagepart-d-contract-and-enrollment-data/monthly-enrollment-contract/plan/state/county
 *
 * - Monthly Enrollment by Plan
 *   https://www.cms.gov/data-research/statistics-trends-and-reports/medicare-advantagepart-d-contract-and-enrollment-data/monthly-enrollment-plan
 *
 * - data.cms.gov API for structured data
 *   https://data.cms.gov/summary-statistics-on-beneficiary-enrollment/medicare-and-medicaid-reports/cms-program-statistics-medicare-advantage-other-health-plan-enrollment
 *
 * File Formats: Excel (.xlsx) and CSV
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';
import config from '../config/index.js';

// Get directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Data directory for downloaded files
const DATA_DIR = path.join(__dirname, '../../data/cms');

// CMS Base URLs
const CMS_BASE = 'https://www.cms.gov';
const CMS_DATA_API = 'https://data.cms.gov/data-api/v1/dataset';

// CPSC page URL pattern
const CPSC_PAGE_URL = 'https://www.cms.gov/data-research/statistics-trends-and-reports/medicare-advantagepart-d-contract-and-enrollment-data/monthly-enrollment-contract/plan/state/county';

// data.cms.gov dataset IDs (these may need to be updated periodically)
const DATASET_IDS = {
  // Medicare Advantage enrollment statistics
  maEnrollment: '9767cb68-8ea9-4f0b-8179-9431abc89f11',
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
 * Get the current year and month for fetching latest data
 */
function getCurrentPeriod() {
  const now = new Date();
  // CMS data has a 1-2 month lag, so go back 2 months
  now.setMonth(now.getMonth() - 2);

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  return { year, month, period: `${year}-${month}` };
}

/**
 * Build the URL for a specific CPSC monthly file page
 */
function getCPSCPageUrl(year, month) {
  const monthPadded = String(month).padStart(2, '0');
  return `${CPSC_PAGE_URL}/monthly-enrollment-cpsc-${year}-${monthPadded}`;
}

/**
 * Fetch a page and extract download links
 * @param {string} url - Page URL to scrape
 * @returns {Promise<string[]>} Array of download URLs
 */
async function getDownloadLinks(url) {
  try {
    console.log(`📄 Fetching page: ${url}`);

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 30000,
    });

    const $ = cheerio.load(response.data);
    const links = [];

    // Find all download links (usually .xlsx, .csv, or .zip files)
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && (href.endsWith('.xlsx') || href.endsWith('.csv') || href.endsWith('.zip'))) {
        // Make absolute URL if needed
        const absoluteUrl = href.startsWith('http') ? href : `${CMS_BASE}${href}`;
        links.push(absoluteUrl);
      }
    });

    console.log(`   Found ${links.length} downloadable files`);
    return links;

  } catch (error) {
    if (error.response?.status === 404) {
      console.log(`   ⚠️ Page not found (data may not be available yet)`);
    } else if (error.response?.status === 403) {
      console.log(`   ⚠️ Access forbidden (CMS may be blocking automated access)`);
    } else {
      console.error(`   ❌ Error fetching page: ${error.message}`);
    }
    return [];
  }
}

/**
 * Download a file from URL to local directory
 * @param {string} url - File URL
 * @param {string} filename - Optional filename override
 * @returns {Promise<string|null>} Local file path or null on error
 */
async function downloadFile(url, filename = null) {
  ensureDataDir();

  // Extract filename from URL if not provided
  if (!filename) {
    filename = path.basename(new URL(url).pathname);
  }

  const localPath = path.join(DATA_DIR, filename);

  // Check if file already exists and is recent (less than 1 day old)
  if (fs.existsSync(localPath)) {
    const stats = fs.statSync(localPath);
    const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

    if (ageHours < 24) {
      console.log(`   📁 Using cached file: ${filename}`);
      return localPath;
    }
  }

  console.log(`   ⬇️ Downloading: ${filename}`);

  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 120000, // 2 minutes for large files
    });

    fs.writeFileSync(localPath, response.data);
    console.log(`   ✅ Downloaded: ${filename} (${(response.data.length / 1024 / 1024).toFixed(2)} MB)`);

    return localPath;

  } catch (error) {
    console.error(`   ❌ Download failed: ${error.message}`);
    return null;
  }
}

/**
 * Parse Excel file using xlsx library
 * @param {string} filePath - Path to Excel file
 * @returns {Promise<object[]>} Array of row objects
 */
async function parseExcelFile(filePath) {
  // Dynamic import of xlsx (will be installed)
  const XLSX = await import('xlsx');

  console.log(`   📊 Parsing Excel file: ${path.basename(filePath)}`);

  const workbook = XLSX.read(fs.readFileSync(filePath));
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];

  // Convert to JSON with headers
  const data = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

  console.log(`   📊 Parsed ${data.length} rows`);
  return data;
}

/**
 * Parse CSV file
 * @param {string} filePath - Path to CSV file
 * @returns {Promise<object[]>} Array of row objects
 */
async function parseCSVFile(filePath) {
  console.log(`   📊 Parsing CSV file: ${path.basename(filePath)}`);

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');

  if (lines.length < 2) return [];

  // Parse header
  const headers = parseCSVLine(lines[0]);

  // Parse data rows
  const data = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};

    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] || '';
    }

    data.push(row);
  }

  console.log(`   📊 Parsed ${data.length} rows`);
  return data;
}

/**
 * Parse a single CSV line handling quoted values
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
 * Extract a ZIP file and find the data file inside
 * @param {string} zipPath - Path to ZIP file
 * @returns {Promise<string>} Path to extracted data file
 */
async function extractZipFile(zipPath) {
  console.log(`   📦 Extracting ZIP file: ${path.basename(zipPath)}`);

  const extractDir = path.join(DATA_DIR, 'extracted');

  // Clean up previous extraction
  if (fs.existsSync(extractDir)) {
    fs.rmSync(extractDir, { recursive: true });
  }
  fs.mkdirSync(extractDir, { recursive: true });

  // Extract the ZIP
  const zip = new AdmZip(zipPath);
  zip.extractAllTo(extractDir, true);

  // Find the data file inside (CSV or Excel)
  const files = fs.readdirSync(extractDir);
  console.log(`   📂 ZIP contents: ${files.join(', ')}`);

  // Prefer XLSX, then CSV, then XLS
  const dataFile = files.find(f => f.endsWith('.xlsx')) ||
                   files.find(f => f.endsWith('.csv')) ||
                   files.find(f => f.endsWith('.xls'));

  if (!dataFile) {
    throw new Error(`No CSV or Excel file found in ZIP. Contents: ${files.join(', ')}`);
  }

  console.log(`   ✅ Found data file: ${dataFile}`);
  return path.join(extractDir, dataFile);
}

/**
 * Parse enrollment file (auto-detect format)
 * @param {string} filePath - Path to file
 * @returns {Promise<object[]>} Array of row objects
 */
async function parseEnrollmentFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls') {
    return parseExcelFile(filePath);
  } else if (ext === '.csv') {
    return parseCSVFile(filePath);
  } else if (ext === '.zip') {
    // Extract ZIP and parse the file inside
    const extractedPath = await extractZipFile(filePath);
    return parseEnrollmentFile(extractedPath);
  } else {
    throw new Error(`Unsupported file format: ${ext}`);
  }
}

/**
 * Normalize CPSC data to our format
 * Aggregates by organization (sums enrollment across plans)
 * @param {object[]} rawData - Raw parsed data
 * @returns {object[]} Normalized organization data
 */
function normalizeCPSCData(rawData) {
  console.log('   🔄 Normalizing CPSC data...');

  // Group by organization
  const orgMap = new Map();

  for (const row of rawData) {
    // Common column name variations
    const orgName = row['Organization Name'] || row['Parent Organization'] ||
                    row['Organization Marketing Name'] || row['Contract Name'] || '';
    const contractId = row['Contract Number'] || row['Contract ID'] || row['Contract'] || '';
    const planId = row['Plan ID'] || row['Plan Number'] || '';
    const state = row['State'] || row['State Code'] || '';
    const enrollment = parseInt(row['Enrollment'] || row['Total Enrollment'] ||
                               row['Enrollees'] || row['Members'] || '0', 10) || 0;
    const planType = row['Plan Type'] || row['Type'] || '';

    if (!orgName || enrollment === 0) continue;

    // Create org key for grouping
    const orgKey = orgName.toLowerCase().trim();

    if (!orgMap.has(orgKey)) {
      orgMap.set(orgKey, {
        name: orgName.trim(),
        contractIds: new Set(),
        planIds: new Set(),
        states: new Set(),
        totalEnrollment: 0,
        planTypes: new Set(),
      });
    }

    const org = orgMap.get(orgKey);
    if (contractId) org.contractIds.add(contractId);
    if (planId) org.planIds.add(`${contractId}-${planId}`);
    if (state) org.states.add(state);
    org.totalEnrollment += enrollment;
    if (planType) org.planTypes.add(planType);
  }

  // Convert to array
  const organizations = Array.from(orgMap.values()).map(org => ({
    name: org.name,
    contractIds: Array.from(org.contractIds),
    planCount: org.planIds.size,
    states: Array.from(org.states),
    memberCount: org.totalEnrollment,
    planTypes: Array.from(org.planTypes),
    type: 'Medicare Advantage',
    dataSources: ['CMS'],
  }));

  // Sort by enrollment descending
  organizations.sort((a, b) => b.memberCount - a.memberCount);

  console.log(`   📊 Normalized to ${organizations.length} organizations`);
  console.log(`   📊 Total enrollment: ${organizations.reduce((sum, o) => sum + o.memberCount, 0).toLocaleString()}`);

  return organizations;
}

/**
 * Fetch data from data.cms.gov API
 * @param {string} datasetId - Dataset UUID
 * @param {object} params - Query parameters
 * @returns {Promise<object[]>} Array of records
 */
async function fetchFromDataCMS(datasetId, params = {}) {
  console.log(`🌐 Fetching from data.cms.gov API...`);

  try {
    const url = `${CMS_DATA_API}/${datasetId}/data`;

    const response = await axios.get(url, {
      params: {
        size: 5000, // Max records per request
        ...params,
      },
      headers: {
        'Accept': 'application/json',
      },
      timeout: 60000,
    });

    const data = response.data;
    console.log(`   ✅ Fetched ${data.length || 0} records from API`);

    return data;

  } catch (error) {
    console.error(`   ❌ API fetch failed: ${error.message}`);
    return [];
  }
}

// ============================================
// MAIN EXPORT FUNCTIONS
// ============================================

/**
 * Download and parse the latest CPSC enrollment data
 * @param {number} year - Year (default: current)
 * @param {number} month - Month (default: current - 2)
 * @returns {Promise<object[]>} Array of normalized organization data
 */
export async function getLatestCPSCData(year = null, month = null) {
  // Default to 2 months ago (CMS data lag)
  if (!year || !month) {
    const period = getCurrentPeriod();
    year = period.year;
    month = parseInt(period.month, 10);
  }

  console.log(`\n📋 Fetching CMS CPSC data for ${year}-${String(month).padStart(2, '0')}...`);

  // Try to get download links from CMS page
  const pageUrl = getCPSCPageUrl(year, month);
  const links = await getDownloadLinks(pageUrl);

  if (links.length === 0) {
    // Try previous month if current not available
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    console.log(`   Trying previous month: ${prevYear}-${String(prevMonth).padStart(2, '0')}...`);

    const prevPageUrl = getCPSCPageUrl(prevYear, prevMonth);
    const prevLinks = await getDownloadLinks(prevPageUrl);

    if (prevLinks.length === 0) {
      console.log('   ⚠️ Could not find CPSC data files. Trying API fallback...');
      return tryAPIFallback();
    }

    return downloadAndParseCPSC(prevLinks);
  }

  return downloadAndParseCPSC(links);
}

/**
 * Download and parse CPSC files from links
 */
async function downloadAndParseCPSC(links) {
  // Find the main CPSC file - prefer xlsx, then zip, then csv
  const dataLink = links.find(l => l.toLowerCase().includes('cpsc') && l.endsWith('.xlsx')) ||
                   links.find(l => l.toLowerCase().includes('cpsc') && l.endsWith('.zip')) ||
                   links.find(l => l.endsWith('.xlsx')) ||
                   links.find(l => l.endsWith('.zip')) ||
                   links.find(l => l.endsWith('.csv')) ||
                   links[0];

  if (!dataLink) {
    console.log('   ⚠️ No suitable download file found');
    return [];
  }

  console.log(`   📥 Selected file: ${path.basename(dataLink)}`);

  const filePath = await downloadFile(dataLink);
  if (!filePath) return [];

  const rawData = await parseEnrollmentFile(filePath);
  return normalizeCPSCData(rawData);
}

/**
 * Try to get data from data.cms.gov API as fallback
 */
async function tryAPIFallback() {
  console.log('   🔄 Attempting data.cms.gov API fallback...');

  const data = await fetchFromDataCMS(DATASET_IDS.maEnrollment);

  if (data.length === 0) {
    console.log('   ⚠️ API fallback also failed');
    return [];
  }

  // Normalize API data
  return data.map(row => ({
    name: row.organization_name || row.plan_name || 'Unknown',
    states: row.state ? [row.state] : [],
    memberCount: parseInt(row.enrollment || row.total_enrollment || '0', 10),
    type: 'Medicare Advantage',
    dataSources: ['CMS'],
  }));
}

/**
 * Get list of available CPSC data periods
 * @returns {Promise<object[]>} Array of { year, month, url }
 */
export async function getAvailablePeriods() {
  console.log('📋 Fetching available CMS data periods...');

  try {
    const response = await axios.get(CPSC_PAGE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 30000,
    });

    const $ = cheerio.load(response.data);
    const periods = [];

    // Find links to monthly data pages
    $('a[href*="monthly-enrollment-cpsc-"]').each((_, el) => {
      const href = $(el).attr('href');
      const match = href.match(/monthly-enrollment-cpsc-(\d{4})-(\d{2})/);

      if (match) {
        periods.push({
          year: parseInt(match[1], 10),
          month: parseInt(match[2], 10),
          url: href.startsWith('http') ? href : `${CMS_BASE}${href}`,
        });
      }
    });

    // Sort by date descending
    periods.sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      return b.month - a.month;
    });

    console.log(`   Found ${periods.length} available periods`);
    return periods;

  } catch (error) {
    console.error(`   ❌ Error fetching periods: ${error.message}`);
    return [];
  }
}

/**
 * Get data directory path for inspection
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
  return fs.readdirSync(DATA_DIR).map(file => ({
    name: file,
    path: path.join(DATA_DIR, file),
    size: fs.statSync(path.join(DATA_DIR, file)).size,
  }));
}

export default {
  getLatestCPSCData,
  getAvailablePeriods,
  getDataDir,
  listDownloadedFiles,
  downloadFile,
  parseEnrollmentFile,
  normalizeCPSCData,
};
