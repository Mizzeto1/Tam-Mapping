# Payer Universe 🏥

A healthcare payer database that aggregates data from multiple sources and syncs to Google Sheets.

**Your Google Sheet = Your UI.** The backend collects and enriches data; you work in the spreadsheet.

```
Data Sources → Backend (Railway) → Google Sheet (You work here)
```

## What This Does

- Collects healthcare payer data from CMS, Apollo.io, and web sources
- Deduplicates and merges records using fuzzy matching
- Syncs everything to a Google Sheet you control
- Provides a clean spreadsheet interface for your team

## Google Sheet Structure

| Tab | Purpose |
|-----|---------|
| **Health Plans** | Main payer universe - plans, MCOs, insurers |
| **TPAs** | Third Party Administrators (healthcare-focused only) |
| **Contacts** | Decision makers at target companies |
| **Pipeline** | Your outreach tracking |
| **Dashboard** | Counts and breakdowns |
| **Logs** | Import history, errors |

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Environment

```bash
# Copy the example environment file
cp .env.example .env

# Edit .env with your settings
```

### 3. Set Up Google Sheets (detailed instructions below)

### 4. Run the App

```bash
# See current configuration
npm start

# Import data and sync to sheets
npm run refresh
```

---

## Available Commands

| Command | What It Does |
|---------|--------------|
| `npm start` | Shows configuration and available commands |
| `npm run dev` | Development mode with auto-reload |
| `npm run import:apollo` | Import contacts from Apollo.io |
| `npm run import:cms` | Import payer data from CMS |
| `npm run sync:sheets` | Push data to Google Sheets |
| `npm run refresh` | Run all imports + sync |

---

## Google Sheets Setup (Step by Step)

This is the most important setup step. Follow carefully!

### Step 1: Create Your Google Sheet

1. Go to [Google Sheets](https://sheets.google.com)
2. Click **"+ Blank"** to create a new spreadsheet
3. Name it something like "Payer Universe Database"
4. Look at the URL - it looks like:
   ```
   https://docs.google.com/spreadsheets/d/1ABC123xyz789/edit
   ```
5. Copy the ID part (between `/d/` and `/edit`): `1ABC123xyz789`
6. Add this to your `.env` file:
   ```
   GOOGLE_SHEET_ID=1ABC123xyz789
   ```

### Step 2: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. If you don't have a Google Cloud account, you can create one for free
3. Click the project dropdown at the top (says "Select a project")
4. Click **"New Project"**
5. Name it "Payer Universe" and click **Create**
6. Wait for it to create (takes ~30 seconds)

### Step 3: Enable the Google Sheets API

1. Make sure your new project is selected at the top
2. Go to **APIs & Services** → **Library** (in the left sidebar)
3. Search for "Google Sheets API"
4. Click on it, then click **"Enable"**

### Step 4: Create Service Account Credentials

This creates a "robot user" that your app uses to access the sheet.

1. Go to **APIs & Services** → **Credentials** (in the left sidebar)
2. Click **"+ Create Credentials"** at the top
3. Select **"Service Account"**
4. Fill in:
   - Service account name: `payer-universe-sync`
   - Service account ID: (auto-fills)
   - Description: `Syncs payer data to Google Sheets`
5. Click **"Create and Continue"**
6. Skip the optional steps (just click **"Done"**)

### Step 5: Download the Credentials File

1. You should see your new service account in the list
2. Click on it to open details
3. Go to the **"Keys"** tab
4. Click **"Add Key"** → **"Create new key"**
5. Choose **JSON** format
6. Click **"Create"**
7. A file will download (keep this safe - it's a secret!)
8. Rename the file to `google-service-account.json`
9. Move it to the `credentials/` folder in your project

### Step 6: Share Your Sheet with the Service Account

This is the step people forget! The robot needs permission.

1. Open the JSON file you downloaded
2. Find the `"client_email"` field - it looks like:
   ```
   payer-universe-sync@your-project.iam.gserviceaccount.com
   ```
3. Copy this email address
4. Go to your Google Sheet
5. Click **"Share"** button (top right)
6. Paste the service account email
7. Give it **"Editor"** access
8. Uncheck "Notify people"
9. Click **"Share"**

### Step 7: Test the Connection

```bash
npm run sync:sheets
```

If everything is set up correctly, you should see a success message!

---

## Troubleshooting

### "Google Sheet ID not configured"
- Make sure you copied `.env.example` to `.env`
- Make sure you added your sheet ID to the `.env` file

### "Could not load credentials"
- Make sure the JSON file is in the `credentials/` folder
- Make sure it's named `google-service-account.json`
- Check that the path in `.env` is correct

### "Permission denied" or "Not found"
- Make sure you shared the sheet with the service account email
- Make sure the service account has "Editor" access
- Double-check the sheet ID is correct

### "API not enabled"
- Go back to Google Cloud Console
- Make sure Google Sheets API is enabled
- Make sure you're in the right project

---

## Project Structure

```
payer-universe/
├── src/
│   ├── config/          # Environment configuration
│   ├── services/        # API integrations (Apollo, etc.)
│   ├── scrapers/        # Web scraping for CMS data
│   ├── sync/            # Google Sheets sync logic
│   ├── scripts/         # Runnable commands
│   └── utils/           # Helper functions
├── credentials/         # Google service account (git-ignored)
├── .env                 # Your environment variables (git-ignored)
├── .env.example         # Template for environment variables
└── package.json         # Project dependencies
```

---

## Deployment (Railway)

Coming soon! This project is designed to run on Railway for scheduled data refreshes.

---

## Security Notes

⚠️ **Never commit these files:**
- `.env` (contains your secrets)
- `credentials/google-service-account.json` (contains your API key)

These are already in `.gitignore` but double-check before pushing!

---

## Support

Having trouble? Check:
1. The troubleshooting section above
2. Make sure all steps were followed exactly
3. Try the setup steps again from the beginning
