/**
 * Google Sheets Sync Module
 *
 * This module handles syncing data from our database to Google Sheets.
 * The Google Sheet is the user interface - this module keeps it updated.
 */

import { google } from 'googleapis';
import config from '../config/index.js';
import db from '../db/index.js';

// Tab names in the Google Sheet
const TABS = {
  HEALTH_PLANS: 'Health Plans',
  TPAS: 'TPAs',
  CONTACTS: 'Contacts',
  DASHBOARD: 'Dashboard',
  PIPELINE: 'Pipeline',
  LOGS: 'Logs',
};

// Rate limiting: Google allows 100 requests per 100 seconds
const RATE_LIMIT_DELAY_MS = 1100; // Just over 1 second between requests

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get authenticated Google Sheets client
 * @returns {Promise<sheets_v4.Sheets>} Google Sheets API client
 */
async function getSheetsClient() {
  let auth;

  // Option 1: Credentials from environment variable (Railway)
  if (config.google.credentialsJson) {
    const credentials = JSON.parse(config.google.credentialsJson);
    auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  // Option 2: Credentials from file (local development)
  else if (config.google.credentialsPath) {
    auth = new google.auth.GoogleAuth({
      keyFile: config.google.credentialsPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  else {
    throw new Error('No Google credentials configured. Set GOOGLE_CREDENTIALS or GOOGLE_APPLICATION_CREDENTIALS');
  }

  const sheets = google.sheets({ version: 'v4', auth });
  return sheets;
}

/**
 * Ensure a tab exists in the spreadsheet
 * @param {sheets_v4.Sheets} sheets - Sheets client
 * @param {string} tabName - Name of the tab
 */
async function ensureTabExists(sheets, tabName) {
  try {
    // Get existing sheets
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: config.google.sheetId,
    });

    const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);

    if (!existingSheets.includes(tabName)) {
      console.log(`📊 Creating tab: ${tabName}`);
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.google.sheetId,
        requestBody: {
          requests: [{
            addSheet: {
              properties: { title: tabName }
            }
          }]
        }
      });
      await sleep(RATE_LIMIT_DELAY_MS);
    }
  } catch (error) {
    console.error(`Error ensuring tab ${tabName}:`, error.message);
    throw error;
  }
}

/**
 * Clear a tab and write new data with formatted header
 * @param {sheets_v4.Sheets} sheets - Sheets client
 * @param {string} tabName - Name of the tab
 * @param {string[]} headers - Column headers
 * @param {any[][]} rows - Data rows
 */
async function writeTabData(sheets, tabName, headers, rows) {
  await ensureTabExists(sheets, tabName);

  // Clear the sheet
  await sheets.spreadsheets.values.clear({
    spreadsheetId: config.google.sheetId,
    range: `'${tabName}'!A:Z`,
  });
  await sleep(RATE_LIMIT_DELAY_MS);

  // Prepare all data (header + rows)
  const allData = [headers, ...rows];

  // Write all data
  await sheets.spreadsheets.values.update({
    spreadsheetId: config.google.sheetId,
    range: `'${tabName}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: allData,
    },
  });
  await sleep(RATE_LIMIT_DELAY_MS);

  // Get the sheet ID for formatting
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: config.google.sheetId,
  });
  const sheet = spreadsheet.data.sheets.find(s => s.properties.title === tabName);
  const sheetId = sheet?.properties?.sheetId;

  if (sheetId !== undefined) {
    // Format header row: bold, frozen, light gray background
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.google.sheetId,
      requestBody: {
        requests: [
          // Freeze header row
          {
            updateSheetProperties: {
              properties: {
                sheetId,
                gridProperties: { frozenRowCount: 1 }
              },
              fields: 'gridProperties.frozenRowCount'
            }
          },
          // Bold header row
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
              },
              cell: {
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 }
                }
              },
              fields: 'userEnteredFormat(textFormat,backgroundColor)'
            }
          },
          // Auto-resize columns
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: 'COLUMNS',
                startIndex: 0,
                endIndex: headers.length
              }
            }
          }
        ]
      }
    });
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  console.log(`📊 ${tabName}: Wrote ${rows.length} rows`);
}

/**
 * Append a row to a tab (for logging)
 * @param {sheets_v4.Sheets} sheets - Sheets client
 * @param {string} tabName - Name of the tab
 * @param {any[]} row - Row data
 */
async function appendRow(sheets, tabName, row) {
  await ensureTabExists(sheets, tabName);

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.google.sheetId,
    range: `'${tabName}'!A:A`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [row],
    },
  });
  await sleep(RATE_LIMIT_DELAY_MS);
}

// ============================================
// SYNC FUNCTIONS
// ============================================

/**
 * Sync all payers to the Health Plans tab
 */
export async function syncHealthPlans() {
  console.log('\n📊 Syncing Health Plans...');
  const sheets = await getSheetsClient();

  // Get payers from database
  const payers = await db.queryAll(`
    SELECT
      name,
      parent_company,
      type,
      states,
      employee_count,
      member_count,
      core_system,
      core_system_source,
      website,
      linkedin_url,
      data_sources,
      updated_at
    FROM payers
    ORDER BY name ASC
  `);

  const headers = [
    'Name',
    'Parent Company',
    'Type',
    'States',
    'Employees',
    'Members',
    'Core System',
    'System Source',
    'Website',
    'LinkedIn',
    'Data Sources',
    'Last Updated'
  ];

  const rows = payers.map(p => [
    p.name || '',
    p.parent_company || '',
    p.type || '',
    (p.states || []).join(', '),
    p.employee_count || '',
    p.member_count || '',
    p.core_system || '',
    p.core_system_source || '',
    p.website || '',
    p.linkedin_url || '',
    (p.data_sources || []).join(', '),
    p.updated_at ? new Date(p.updated_at).toLocaleDateString() : ''
  ]);

  await writeTabData(sheets, TABS.HEALTH_PLANS, headers, rows);
  return payers.length;
}

/**
 * Sync healthcare-focused TPAs to the TPAs tab
 */
export async function syncTPAs() {
  console.log('\n📊 Syncing TPAs...');
  const sheets = await getSheetsClient();

  // Get TPAs that are healthcare-focused
  const tpas = await db.queryAll(`
    SELECT
      name,
      parent_company,
      type,
      states,
      employee_count,
      member_count,
      core_system,
      core_system_source,
      website,
      linkedin_url,
      data_sources,
      healthcare_keywords_found,
      updated_at
    FROM tpas
    WHERE is_healthcare_focused = true
    ORDER BY name ASC
  `);

  const headers = [
    'Name',
    'Parent Company',
    'Type',
    'States',
    'Employees',
    'Members',
    'Core System',
    'System Source',
    'Website',
    'LinkedIn',
    'Data Sources',
    'Healthcare Keywords',
    'Last Updated'
  ];

  const rows = tpas.map(t => [
    t.name || '',
    t.parent_company || '',
    t.type || '',
    (t.states || []).join(', '),
    t.employee_count || '',
    t.member_count || '',
    t.core_system || '',
    t.core_system_source || '',
    t.website || '',
    t.linkedin_url || '',
    (t.data_sources || []).join(', '),
    (t.healthcare_keywords_found || []).join(', '),
    t.updated_at ? new Date(t.updated_at).toLocaleDateString() : ''
  ]);

  await writeTabData(sheets, TABS.TPAS, headers, rows);
  return tpas.length;
}

/**
 * Sync contacts to the Contacts tab
 */
export async function syncContacts() {
  console.log('\n📊 Syncing Contacts...');
  const sheets = await getSheetsClient();

  // Get contacts with company name joined
  const contacts = await db.queryAll(`
    SELECT
      c.name,
      c.title,
      c.email,
      c.phone,
      c.linkedin_url,
      c.source,
      COALESCE(p.name, t.name) as company_name
    FROM contacts c
    LEFT JOIN payers p ON c.payer_id = p.id
    LEFT JOIN tpas t ON c.tpa_id = t.id
    ORDER BY company_name ASC, c.name ASC
  `);

  const headers = [
    'Company',
    'Name',
    'Title',
    'Email',
    'Phone',
    'LinkedIn',
    'Source'
  ];

  const rows = contacts.map(c => [
    c.company_name || '',
    c.name || '',
    c.title || '',
    c.email || '',
    c.phone || '',
    c.linkedin_url || '',
    c.source || ''
  ]);

  await writeTabData(sheets, TABS.CONTACTS, headers, rows);
  return contacts.length;
}

/**
 * Update the Dashboard tab with summary statistics
 */
export async function updateDashboard() {
  console.log('\n📊 Updating Dashboard...');
  const sheets = await getSheetsClient();

  // Get various statistics
  const totalPayers = await db.queryOne('SELECT COUNT(*) as count FROM payers');
  const totalTPAs = await db.queryOne('SELECT COUNT(*) as count FROM tpas WHERE is_healthcare_focused = true');
  const totalContacts = await db.queryOne('SELECT COUNT(*) as count FROM contacts');

  // Breakdown by type
  const byType = await db.queryAll(`
    SELECT type, COUNT(*) as count
    FROM payers
    GROUP BY type
    ORDER BY count DESC
  `);

  // Top 10 states
  const byState = await db.queryAll(`
    SELECT unnest(states) as state, COUNT(*) as count
    FROM payers
    GROUP BY state
    ORDER BY count DESC
    LIMIT 10
  `);

  // By core system
  const bySystem = await db.queryAll(`
    SELECT COALESCE(core_system, 'Unknown') as system, COUNT(*) as count
    FROM payers
    GROUP BY core_system
    ORDER BY count DESC
  `);

  // Build dashboard data
  const headers = ['Metric', 'Value'];
  const rows = [
    ['SUMMARY', ''],
    ['Total Health Plans', totalPayers?.count || 0],
    ['Total TPAs (Healthcare)', totalTPAs?.count || 0],
    ['Total Contacts', totalContacts?.count || 0],
    ['', ''],
    ['BY TYPE', ''],
    ...byType.map(r => [r.type || 'Unknown', r.count]),
    ['', ''],
    ['TOP 10 STATES', ''],
    ...byState.map(r => [r.state, r.count]),
    ['', ''],
    ['BY CORE SYSTEM', ''],
    ...bySystem.map(r => [r.system, r.count]),
    ['', ''],
    ['Last Updated', new Date().toLocaleString()],
  ];

  await writeTabData(sheets, TABS.DASHBOARD, headers, rows);
}

/**
 * Log an import to the Logs tab
 * @param {string} source - Import source name
 * @param {object} stats - Import statistics
 */
export async function logImport(source, stats) {
  console.log('\n📊 Logging import...');
  const sheets = await getSheetsClient();

  // Ensure headers exist (check if tab is empty)
  await ensureTabExists(sheets, TABS.LOGS);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.google.sheetId,
    range: `'${TABS.LOGS}'!A1:A1`,
  });

  if (!response.data.values || response.data.values.length === 0) {
    // Add headers first
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.google.sheetId,
      range: `'${TABS.LOGS}'!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [['Timestamp', 'Source', 'Records Found', 'Added', 'Updated', 'Errors']],
      },
    });
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  const row = [
    new Date().toLocaleString(),
    source,
    stats.found || 0,
    stats.added || 0,
    stats.updated || 0,
    (stats.errors || []).join('; ')
  ];

  await appendRow(sheets, TABS.LOGS, row);
}

/**
 * Sync everything to Google Sheets
 */
export async function syncAll() {
  console.log('🔄 Starting full sync to Google Sheets...\n');
  const startTime = Date.now();

  try {
    const healthPlansCount = await syncHealthPlans();
    const tpasCount = await syncTPAs();
    const contactsCount = await syncContacts();
    await updateDashboard();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Sync complete in ${elapsed}s`);
    console.log(`   Health Plans: ${healthPlansCount}`);
    console.log(`   TPAs: ${tpasCount}`);
    console.log(`   Contacts: ${contactsCount}`);

    return { healthPlansCount, tpasCount, contactsCount };
  } catch (error) {
    console.error('\n❌ Sync failed:', error.message);
    throw error;
  }
}

/**
 * Test the Google Sheets connection
 */
export async function testConnection() {
  console.log('🔗 Testing Google Sheets connection...\n');

  try {
    const sheets = await getSheetsClient();

    // Try to read spreadsheet metadata
    const response = await sheets.spreadsheets.get({
      spreadsheetId: config.google.sheetId,
    });

    console.log('✅ Connected successfully!');
    console.log(`   Spreadsheet: ${response.data.properties.title}`);
    console.log(`   Sheets: ${response.data.sheets.map(s => s.properties.title).join(', ')}`);

    return true;
  } catch (error) {
    console.error('❌ Connection failed:', error.message);

    if (error.message.includes('not found')) {
      console.log('\n💡 Check that:');
      console.log('   1. GOOGLE_SHEET_ID is correct');
      console.log('   2. The sheet is shared with the service account email');
    }

    return false;
  }
}

export default {
  syncHealthPlans,
  syncTPAs,
  syncContacts,
  updateDashboard,
  logImport,
  syncAll,
  testConnection,
  TABS,
};
