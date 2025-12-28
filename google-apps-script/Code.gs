/**
 * Payer Universe - Google Sheets Menu Integration
 *
 * This Apps Script adds a custom menu to your Google Sheet
 * that lets you trigger data refreshes directly from the spreadsheet.
 *
 * SETUP:
 * 1. Open your Google Sheet
 * 2. Go to Extensions > Apps Script
 * 3. Delete any existing code and paste this entire file
 * 4. Update the CONFIG section below with your Railway URL and key
 * 5. Save (Ctrl+S)
 * 6. Refresh your Google Sheet
 * 7. You'll see a new menu called "Payer Universe"
 */

// ============================================
// CONFIGURATION - UPDATE THESE VALUES
// ============================================

const CONFIG = {
  // Your Railway app URL (e.g., "https://your-app.up.railway.app")
  // Find this in Railway dashboard > your service > Settings > Domains
  RAILWAY_URL: "https://YOUR-APP-NAME.up.railway.app",

  // Your secret refresh key (must match REFRESH_KEY env var in Railway)
  // If you didn't set one, leave this empty
  REFRESH_KEY: "your-secret-key-here",

  // Request timeout in seconds
  TIMEOUT: 300,
};

// ============================================
// MENU SETUP
// ============================================

/**
 * Creates the custom menu when the spreadsheet opens
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Payer Universe')
    .addItem('Check Status', 'checkStatus')
    .addSeparator()
    .addItem('Run Full Refresh', 'runRefresh')
    .addSeparator()
    .addSubMenu(ui.createMenu('Import Data')
      .addItem('Import from Apollo', 'importApollo')
      .addItem('Import from CMS', 'importCms'))
    .addSubMenu(ui.createMenu('Other Actions')
      .addItem('Sync to Sheets', 'syncSheets')
      .addItem('Classify TPAs', 'classifyTpas')
      .addItem('Run Migrations', 'runMigrations'))
    .addSeparator()
    .addItem('View Last Job', 'viewLastJob')
    .addToUi();
}

// ============================================
// API HELPER FUNCTIONS
// ============================================

/**
 * Make an API request to the Railway server
 */
function apiRequest(endpoint) {
  const url = `${CONFIG.RAILWAY_URL}${endpoint}?key=${encodeURIComponent(CONFIG.REFRESH_KEY)}`;

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'GET',
      muteHttpExceptions: true,
      timeout: CONFIG.TIMEOUT,
    });

    const code = response.getResponseCode();
    const body = response.getContentText();

    try {
      return { code, data: JSON.parse(body) };
    } catch (e) {
      return { code, data: { message: body } };
    }
  } catch (error) {
    return { code: 0, data: { error: error.message } };
  }
}

/**
 * Show a dialog with results
 */
function showResult(title, result) {
  const ui = SpreadsheetApp.getUi();

  if (result.code === 0) {
    ui.alert(title, `Connection failed: ${result.data.error}\n\nCheck your RAILWAY_URL in the script.`, ui.ButtonSet.OK);
    return;
  }

  if (result.code === 401) {
    ui.alert(title, 'Unauthorized. Check your REFRESH_KEY in the script.', ui.ButtonSet.OK);
    return;
  }

  if (result.code === 409) {
    ui.alert(title, `A job is already running: ${result.data.job?.name}\n\nStarted: ${result.data.job?.startedAt}`, ui.ButtonSet.OK);
    return;
  }

  if (result.data.success === false) {
    ui.alert(title, `Failed: ${result.data.error}`, ui.ButtonSet.OK);
    return;
  }

  // Format the response nicely
  let message = '';
  if (result.data.message) {
    message = result.data.message;
  } else {
    message = JSON.stringify(result.data, null, 2);
  }

  ui.alert(title, message, ui.ButtonSet.OK);
}

/**
 * Show a loading message and run a long operation
 */
function runWithProgress(title, endpoint) {
  const ui = SpreadsheetApp.getUi();

  // Confirm before running
  const confirm = ui.alert(
    title,
    'This may take several minutes. Continue?',
    ui.ButtonSet.YES_NO
  );

  if (confirm !== ui.Button.YES) {
    return;
  }

  // Show toast that we're starting
  SpreadsheetApp.getActiveSpreadsheet().toast('Starting... This may take a few minutes.', title, -1);

  // Make the request
  const result = apiRequest(endpoint);

  // Clear the toast
  SpreadsheetApp.getActiveSpreadsheet().toast('', '', 1);

  // Show result
  showResult(title, result);
}

// ============================================
// MENU ACTIONS
// ============================================

/**
 * Check server status and database counts
 */
function checkStatus() {
  const result = apiRequest('/status');

  if (result.code !== 200) {
    showResult('Status Check', result);
    return;
  }

  const data = result.data;
  const message = `
Database: ${data.database}

Record Counts:
  - Payers: ${data.counts?.payers || 0}
  - TPAs: ${data.counts?.tpas || 0}
  - Contacts: ${data.counts?.contacts || 0}

Configuration:
  - Google Sheet: ${data.config?.googleSheet}
  - Apollo API: ${data.config?.apolloApi}

Last Job: ${data.lastJob ? `${data.lastJob.name} (${data.lastJob.status})` : 'None'}
  `.trim();

  SpreadsheetApp.getUi().alert('Payer Universe Status', message, SpreadsheetApp.getUi().ButtonSet.OK);
}

/**
 * Run full data refresh
 */
function runRefresh() {
  runWithProgress('Full Refresh', '/refresh');
}

/**
 * Import from Apollo
 */
function importApollo() {
  runWithProgress('Apollo Import', '/import/apollo');
}

/**
 * Import from CMS
 */
function importCms() {
  runWithProgress('CMS Import', '/import/cms');
}

/**
 * Sync to Google Sheets
 */
function syncSheets() {
  runWithProgress('Sync to Sheets', '/sync');
}

/**
 * Classify TPAs
 */
function classifyTpas() {
  runWithProgress('Classify TPAs', '/classify');
}

/**
 * Run database migrations
 */
function runMigrations() {
  const ui = SpreadsheetApp.getUi();

  const confirm = ui.alert(
    'Run Migrations',
    'This will set up or update database tables. Continue?',
    ui.ButtonSet.YES_NO
  );

  if (confirm !== ui.Button.YES) {
    return;
  }

  SpreadsheetApp.getActiveSpreadsheet().toast('Running migrations...', 'Migrations', -1);
  const result = apiRequest('/migrate');
  SpreadsheetApp.getActiveSpreadsheet().toast('', '', 1);

  showResult('Migrations', result);
}

/**
 * View last job details
 */
function viewLastJob() {
  const result = apiRequest('/job');

  if (result.code !== 200) {
    showResult('Job History', result);
    return;
  }

  const data = result.data;
  let message = '';

  if (data.currentJob) {
    message += `CURRENT JOB:\n`;
    message += `  Name: ${data.currentJob.name}\n`;
    message += `  Status: ${data.currentJob.status}\n`;
    message += `  Started: ${data.currentJob.startedAt}\n\n`;
  }

  if (data.history && data.history.length > 0) {
    message += `RECENT JOBS:\n`;
    data.history.forEach((job, i) => {
      message += `\n${i + 1}. ${job.name}\n`;
      message += `   Status: ${job.status}\n`;
      message += `   Started: ${job.startedAt}\n`;
      if (job.finishedAt) {
        message += `   Finished: ${job.finishedAt}\n`;
      }
      if (job.error) {
        message += `   Error: ${job.error}\n`;
      }
    });
  } else {
    message += 'No job history available.';
  }

  SpreadsheetApp.getUi().alert('Job History', message, SpreadsheetApp.getUi().ButtonSet.OK);
}
