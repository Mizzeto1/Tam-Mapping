/**
 * Database Migration Runner
 *
 * This script runs all pending migrations in order.
 * Migrations are tracked in the 'migrations' table to prevent re-running.
 *
 * Usage: npm run migrate
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db from '../db/index.js';

// Get directory name in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Path to migrations folder
const MIGRATIONS_DIR = path.join(__dirname, '../db/migrations');

/**
 * Ensure the migrations tracking table exists
 */
async function ensureMigrationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    )
  `);
}

/**
 * Get list of already-executed migrations
 * @returns {Promise<string[]>} Array of migration names
 */
async function getExecutedMigrations() {
  try {
    const result = await db.queryAll('SELECT name FROM migrations ORDER BY name');
    return result.map(row => row.name);
  } catch (error) {
    // Table might not exist yet
    return [];
  }
}

/**
 * Get all migration files from the migrations directory
 * @returns {string[]} Array of migration filenames, sorted
 */
function getMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.log('📁 No migrations directory found');
    return [];
  }

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(file => file.endsWith('.sql'))
    .sort();

  return files;
}

/**
 * Run a single migration file
 * @param {string} filename - Migration filename
 */
async function runMigration(filename) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filePath, 'utf-8');

  console.log(`\n🔄 Running migration: ${filename}`);

  try {
    // Run the migration
    await db.query(sql);

    // Record that it was executed
    await db.query(
      'INSERT INTO migrations (name) VALUES ($1)',
      [filename]
    );

    console.log(`✅ Completed: ${filename}`);
  } catch (error) {
    console.error(`❌ Failed: ${filename}`);
    console.error(`   Error: ${error.message}`);
    throw error;
  }
}

/**
 * Main migration runner
 */
async function runMigrations() {
  console.log('🗄️  Database Migration Runner');
  console.log('==============================\n');

  try {
    // Test database connection
    const connected = await db.testConnection();
    if (!connected) {
      console.error('\n❌ Cannot connect to database. Check your DATABASE_URL.');
      process.exit(1);
    }

    // Ensure migrations table exists
    await ensureMigrationsTable();

    // Get executed and pending migrations
    const executed = await getExecutedMigrations();
    const allMigrations = getMigrationFiles();
    const pending = allMigrations.filter(m => !executed.includes(m));

    console.log(`📊 Status:`);
    console.log(`   Total migrations: ${allMigrations.length}`);
    console.log(`   Already executed: ${executed.length}`);
    console.log(`   Pending: ${pending.length}`);

    if (pending.length === 0) {
      console.log('\n✅ Database is up to date!');
      await db.closePool();
      return;
    }

    console.log(`\n📋 Pending migrations:`);
    pending.forEach(m => console.log(`   - ${m}`));

    // Run each pending migration
    for (const migration of pending) {
      await runMigration(migration);
    }

    console.log('\n🎉 All migrations completed successfully!');

  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    process.exit(1);
  } finally {
    await db.closePool();
  }
}

// Run migrations
runMigrations();
