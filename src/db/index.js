/**
 * Database Connection Module
 *
 * This module handles connecting to PostgreSQL and provides
 * helper functions for running queries.
 *
 * Railway provides DATABASE_URL automatically when you add Postgres.
 * SSL is required for Railway Postgres connections.
 */

import pg from 'pg';
import config from '../config/index.js';

const { Pool } = pg;

// Create connection pool
let pool = null;

/**
 * Get or create the database connection pool
 * @returns {Pool} PostgreSQL connection pool
 */
export function getPool() {
  if (!pool) {
    const poolConfig = {
      connectionString: config.database.url,
      // Connection pool settings from config
      max: config.database.pool.max,
      idleTimeoutMillis: config.database.pool.idleTimeoutMillis,
      connectionTimeoutMillis: config.database.pool.connectionTimeoutMillis,
    };

    // SSL configuration for Railway and cloud databases
    if (config.database.ssl) {
      poolConfig.ssl = {
        rejectUnauthorized: false, // Required for Railway self-signed certs
      };
    }

    pool = new Pool(poolConfig);

    // Log connection events in development
    if (config.isDev) {
      pool.on('connect', () => {
        console.log('📦 Database: New client connected');
      });
    }

    // Log errors (in both dev and prod)
    pool.on('error', (err) => {
      if (config.isProd) {
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          message: 'Database pool error',
          error: err.message,
        }));
      } else {
        console.error('📦 Database: Unexpected error on idle client', err);
      }
    });
  }

  return pool;
}

/**
 * Run a SQL query
 * @param {string} text - SQL query
 * @param {any[]} params - Query parameters
 * @returns {Promise<pg.QueryResult>} Query result
 */
export async function query(text, params = []) {
  const pool = getPool();
  const start = Date.now();

  try {
    const result = await pool.query(text, params);

    if (config.isDev && config.logging.level === 'debug') {
      const duration = Date.now() - start;
      console.log('📦 Query:', { text: text.substring(0, 100), duration: `${duration}ms`, rows: result.rowCount });
    }

    return result;
  } catch (error) {
    console.error('📦 Query error:', error.message);
    throw error;
  }
}

/**
 * Run a query and return first row (or null)
 * @param {string} text - SQL query
 * @param {any[]} params - Query parameters
 * @returns {Promise<any>} First row or null
 */
export async function queryOne(text, params = []) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

/**
 * Run a query and return all rows
 * @param {string} text - SQL query
 * @param {any[]} params - Query parameters
 * @returns {Promise<any[]>} Array of rows
 */
export async function queryAll(text, params = []) {
  const result = await query(text, params);
  return result.rows;
}

/**
 * Test database connection
 * @returns {Promise<boolean>} True if connected successfully
 */
export async function testConnection() {
  try {
    const result = await query('SELECT NOW() as now');
    console.log('📦 Database: Connected successfully at', result.rows[0].now);
    return true;
  } catch (error) {
    console.error('📦 Database: Connection failed -', error.message);
    return false;
  }
}

/**
 * Close all database connections
 */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('📦 Database: All connections closed');
  }
}

// Export pool for advanced usage
export { pool };

// Default export with all functions
export default {
  getPool,
  query,
  queryOne,
  queryAll,
  testConnection,
  closePool,
};
