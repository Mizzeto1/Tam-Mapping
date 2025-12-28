/**
 * Payer Universe - Main Entry Point
 *
 * This file runs an HTTP server that provides API endpoints for:
 * - Health checks
 * - Database migrations
 * - Data imports (Apollo, CMS)
 * - Google Sheets sync
 *
 * These endpoints can be triggered from Google Sheets via Apps Script.
 */

import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import config from './config/index.js';
import logger from './utils/logger.js';
import db from './db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// JOB TRACKING
// ============================================

let currentJob = null;
const jobHistory = [];

function isJobRunning() {
  return currentJob !== null && currentJob.status === 'running';
}

function startJob(name) {
  const job = {
    id: Date.now(),
    name,
    status: 'running',
    startedAt: new Date().toISOString(),
    output: [],
  };
  currentJob = job;
  return job;
}

function finishJob(success, error = null) {
  if (currentJob) {
    currentJob.status = success ? 'completed' : 'failed';
    currentJob.finishedAt = new Date().toISOString();
    currentJob.error = error;
    jobHistory.unshift(currentJob);
    if (jobHistory.length > 10) jobHistory.pop();
    currentJob = null;
  }
}

// ============================================
// SCRIPT RUNNER
// ============================================

function runScript(scriptName, args = []) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, 'scripts', scriptName);
    const child = spawn('node', [scriptPath, ...args], {
      cwd: process.cwd(),
      env: process.env,
    });

    let output = '';

    child.stdout.on('data', (data) => {
      const text = data.toString();
      output += text;
      if (currentJob) currentJob.output.push(text);
      console.log(text);
    });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      output += text;
      if (currentJob) currentJob.output.push(text);
      console.error(text);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Script exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

// ============================================
// HTTP SERVER
// ============================================

function parseUrl(url) {
  const [pathPart, queryPart] = url.split('?');
  const params = {};
  if (queryPart) {
    queryPart.split('&').forEach(pair => {
      const [key, value] = pair.split('=');
      params[decodeURIComponent(key)] = decodeURIComponent(value || '');
    });
  }
  return { path: pathPart, params };
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data, null, 2));
}

function checkAuth(params) {
  const refreshKey = process.env.REFRESH_KEY;
  if (!refreshKey) return true; // No key set = no auth required
  return params.key === refreshKey;
}

async function handleRequest(req, res) {
  const { path, params } = parseUrl(req.url);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // Health check (no auth)
  if (path === '/' || path === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'Payer Universe',
      timestamp: new Date().toISOString(),
    });
  }

  // All other endpoints require auth
  if (!checkAuth(params)) {
    return sendJson(res, 401, { error: 'Unauthorized. Provide ?key=YOUR_REFRESH_KEY' });
  }

  // Check if job is running
  if (isJobRunning() && !['/status', '/job'].includes(path)) {
    return sendJson(res, 409, {
      error: 'A job is already running',
      job: {
        name: currentJob.name,
        startedAt: currentJob.startedAt,
      },
    });
  }

  try {
    switch (path) {
      case '/status': {
        const dbConnected = await db.testConnection();
        let counts = { payers: 0, tpas: 0, contacts: 0 };

        if (dbConnected) {
          try {
            const payersResult = await db.queryOne('SELECT COUNT(*) as count FROM payers');
            const tpasResult = await db.queryOne('SELECT COUNT(*) as count FROM tpas');
            const contactsResult = await db.queryOne('SELECT COUNT(*) as count FROM contacts');
            counts = {
              payers: parseInt(payersResult?.count || 0),
              tpas: parseInt(tpasResult?.count || 0),
              contacts: parseInt(contactsResult?.count || 0),
            };
          } catch (e) {
            // Tables might not exist yet
          }
        }

        return sendJson(res, 200, {
          status: 'ok',
          database: dbConnected ? 'connected' : 'disconnected',
          counts,
          currentJob: currentJob ? { name: currentJob.name, status: currentJob.status } : null,
          lastJob: jobHistory[0] || null,
          config: {
            googleSheet: config.google.sheetId ? 'configured' : 'not set',
            apolloApi: config.apollo.hasApiKey ? 'configured' : 'not set',
          },
        });
      }

      case '/job': {
        return sendJson(res, 200, {
          currentJob,
          history: jobHistory.slice(0, 5),
        });
      }

      case '/migrate': {
        startJob('migrate');
        try {
          await runScript('migrate.js');
          finishJob(true);
          return sendJson(res, 200, { success: true, message: 'Migrations completed' });
        } catch (error) {
          finishJob(false, error.message);
          return sendJson(res, 500, { success: false, error: error.message });
        }
      }

      case '/refresh': {
        startJob('refresh');
        try {
          await runScript('refresh.js');
          finishJob(true);
          return sendJson(res, 200, { success: true, message: 'Full refresh completed' });
        } catch (error) {
          finishJob(false, error.message);
          return sendJson(res, 500, { success: false, error: error.message });
        }
      }

      case '/import/apollo': {
        startJob('import-apollo');
        try {
          await runScript('import-apollo.js');
          finishJob(true);
          return sendJson(res, 200, { success: true, message: 'Apollo import completed' });
        } catch (error) {
          finishJob(false, error.message);
          return sendJson(res, 500, { success: false, error: error.message });
        }
      }

      case '/import/cms': {
        startJob('import-cms');
        try {
          await runScript('import-cms.js');
          finishJob(true);
          return sendJson(res, 200, { success: true, message: 'CMS import completed' });
        } catch (error) {
          finishJob(false, error.message);
          return sendJson(res, 500, { success: false, error: error.message });
        }
      }

      case '/sync': {
        startJob('sync-sheets');
        try {
          await runScript('sync-sheets.js');
          finishJob(true);
          return sendJson(res, 200, { success: true, message: 'Google Sheets sync completed' });
        } catch (error) {
          finishJob(false, error.message);
          return sendJson(res, 500, { success: false, error: error.message });
        }
      }

      case '/classify': {
        startJob('classify-tpas');
        try {
          await runScript('classify-tpas.js');
          finishJob(true);
          return sendJson(res, 200, { success: true, message: 'TPA classification completed' });
        } catch (error) {
          finishJob(false, error.message);
          return sendJson(res, 500, { success: false, error: error.message });
        }
      }

      default:
        return sendJson(res, 404, { error: 'Not found' });
    }
  } catch (error) {
    logger.error('Request error', { path, error: error.message });
    return sendJson(res, 500, { error: error.message });
  }
}

// ============================================
// GLOBAL ERROR HANDLING
// ============================================

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {
    error: error.message,
    stack: error.stack,
  });
  setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await db.closePool();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await db.closePool();
  process.exit(0);
});

// ============================================
// STARTUP
// ============================================

async function main() {
  logger.info('Payer Universe starting', {
    env: config.env,
    railway: config.isRailway,
    nodeVersion: process.version,
  });

  console.log('\n🏥 Payer Universe - Healthcare Payer Database');
  console.log('============================================');
  console.log(`Environment: ${config.env}${config.isRailway ? ' (Railway)' : ''}`);
  console.log(`Port: ${config.port}`);
  console.log(`Google Sheet: ${config.google.sheetId ? '✓ Configured' : '✗ Not set'}`);
  console.log(`Apollo API: ${config.apollo.hasApiKey ? '✓ Configured' : '○ Not set'}`);
  console.log(`Auth Key: ${process.env.REFRESH_KEY ? '✓ Set' : '○ Not set (no auth)'}`);
  console.log('============================================');

  // Test database connection
  console.log('\n📦 Testing database connection...');
  const dbConnected = await db.testConnection();
  if (!dbConnected) {
    console.log('⚠️  Database not connected. Call /migrate to set up.');
  }

  // Start HTTP server
  const server = http.createServer(handleRequest);

  server.listen(config.port, () => {
    console.log(`\n🚀 Server running on port ${config.port}`);
    console.log('\n📡 API Endpoints:');
    console.log(`   GET /              - Health check`);
    console.log(`   GET /status?key=   - Database status and counts`);
    console.log(`   GET /migrate?key=  - Run migrations`);
    console.log(`   GET /refresh?key=  - Full data refresh`);
    console.log(`   GET /import/apollo?key= - Import from Apollo`);
    console.log(`   GET /import/cms?key=    - Import from CMS`);
    console.log(`   GET /sync?key=     - Sync to Google Sheets`);
    console.log(`   GET /classify?key= - Classify TPAs`);
    console.log('\n✅ Ready to accept requests');
  });
}

main().catch((error) => {
  logger.error('Startup failed', { error: error.message });
  process.exit(1);
});
