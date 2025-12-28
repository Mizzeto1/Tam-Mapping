/**
 * Test Google Sheets Connection
 *
 * This script tests the Google Sheets connection and writes sample data.
 * Use this to verify your credentials are set up correctly.
 *
 * Usage: npm run test:sheets
 */

import { google } from 'googleapis';
import config from '../config/index.js';

async function testSheets() {
  console.log('🧪 Google Sheets Connection Test');
  console.log('=================================\n');

  // Check configuration
  console.log('📋 Configuration:');
  console.log(`   Sheet ID: ${config.google.sheetId ? '✓ Set' : '✗ Missing'}`);
  console.log(`   Credentials JSON: ${config.google.credentialsJson ? '✓ Set (env var)' : '✗ Not set'}`);
  console.log(`   Credentials File: ${config.google.credentialsPath}`);
  console.log('');

  if (!config.google.sheetId) {
    console.error('❌ GOOGLE_SHEET_ID is not set in your .env file');
    process.exit(1);
  }

  try {
    // Get authenticated client
    let auth;

    if (config.google.credentialsJson) {
      console.log('🔐 Using credentials from GOOGLE_CREDENTIALS env var...');
      const credentials = JSON.parse(config.google.credentialsJson);
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else {
      console.log(`🔐 Using credentials from file: ${config.google.credentialsPath}...`);
      auth = new google.auth.GoogleAuth({
        keyFile: config.google.credentialsPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    }

    const sheets = google.sheets({ version: 'v4', auth });

    // Test 1: Read spreadsheet metadata
    console.log('\n📖 Test 1: Reading spreadsheet...');
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: config.google.sheetId,
    });

    console.log(`   ✅ Connected to: "${spreadsheet.data.properties.title}"`);
    console.log(`   📑 Existing tabs: ${spreadsheet.data.sheets.map(s => s.properties.title).join(', ') || '(none)'}`);

    // Test 2: Create a test tab
    console.log('\n📝 Test 2: Creating test tab...');
    const testTabName = 'Test Connection';

    // Check if tab exists
    const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);
    if (!existingSheets.includes(testTabName)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.google.sheetId,
        requestBody: {
          requests: [{
            addSheet: { properties: { title: testTabName } }
          }]
        }
      });
      console.log(`   ✅ Created tab: "${testTabName}"`);
    } else {
      console.log(`   ✅ Tab already exists: "${testTabName}"`);
    }

    // Test 3: Write sample data
    console.log('\n📝 Test 3: Writing sample data...');

    const sampleData = [
      ['Name', 'Type', 'State', 'Status'],
      ['Blue Cross Blue Shield', 'Health Plan', 'CA, NY, TX', 'Active'],
      ['Aetna', 'Insurer', 'All States', 'Active'],
      ['UnitedHealthcare', 'MCO', 'CA, FL, NY', 'Active'],
      ['', '', '', ''],
      ['Test completed at:', new Date().toLocaleString(), '', ''],
    ];

    await sheets.spreadsheets.values.update({
      spreadsheetId: config.google.sheetId,
      range: `'${testTabName}'!A1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: sampleData },
    });

    console.log(`   ✅ Wrote ${sampleData.length} rows to "${testTabName}"`);

    // Test 4: Format header
    console.log('\n🎨 Test 4: Formatting header...');

    const sheet = spreadsheet.data.sheets.find(s => s.properties.title === testTabName) ||
      (await sheets.spreadsheets.get({ spreadsheetId: config.google.sheetId }))
        .data.sheets.find(s => s.properties.title === testTabName);

    if (sheet) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.google.sheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId: sheet.properties.sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                },
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true },
                    backgroundColor: { red: 0.2, green: 0.6, blue: 0.9 },
                  }
                },
                fields: 'userEnteredFormat(textFormat,backgroundColor)'
              }
            },
            {
              updateSheetProperties: {
                properties: {
                  sheetId: sheet.properties.sheetId,
                  gridProperties: { frozenRowCount: 1 }
                },
                fields: 'gridProperties.frozenRowCount'
              }
            }
          ]
        }
      });
      console.log('   ✅ Header formatted (bold, colored, frozen)');
    }

    // Success!
    console.log('\n' + '='.repeat(50));
    console.log('🎉 ALL TESTS PASSED!');
    console.log('='.repeat(50));
    console.log('\nYour Google Sheets connection is working correctly.');
    console.log(`Check your sheet: https://docs.google.com/spreadsheets/d/${config.google.sheetId}`);
    console.log('\nYou can delete the "Test Connection" tab if you want.');

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    console.log('\n💡 Troubleshooting:');

    if (error.message.includes('Could not load the default credentials')) {
      console.log('   - Make sure your credentials JSON file exists at the path specified');
      console.log('   - Or set GOOGLE_CREDENTIALS env var with the JSON content');
    } else if (error.message.includes('not found') || error.message.includes('404')) {
      console.log('   - Check that GOOGLE_SHEET_ID is correct');
      console.log('   - Make sure you shared the sheet with the service account email');
    } else if (error.message.includes('permission') || error.message.includes('403')) {
      console.log('   - The service account needs Editor access to the sheet');
      console.log('   - Share the sheet with the client_email from your JSON file');
    } else if (error.message.includes('invalid_grant')) {
      console.log('   - The credentials may be expired or invalid');
      console.log('   - Try creating a new key in Google Cloud Console');
    }

    process.exit(1);
  }
}

testSheets();
