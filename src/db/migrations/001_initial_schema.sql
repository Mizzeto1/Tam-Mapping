-- ============================================
-- PAYER UNIVERSE - Initial Database Schema
-- Migration: 001_initial_schema.sql
-- ============================================

-- Create custom enum types
CREATE TYPE payer_type AS ENUM (
  'Health Plan',
  'MCO',
  'Medicare Advantage',
  'Insurer',
  'Other'
);

CREATE TYPE core_system_source AS ENUM (
  'Job Posting',
  'Confirmed',
  'Website',
  'Unknown'
);

CREATE TYPE contact_source AS ENUM (
  'Apollo',
  'LinkedIn',
  'Manual'
);

-- ============================================
-- PAYERS TABLE
-- Health plans, MCOs, insurers
-- ============================================
CREATE TABLE payers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  parent_company VARCHAR(255),
  type payer_type DEFAULT 'Other',
  states TEXT[] DEFAULT '{}',
  employee_count INTEGER,
  member_count INTEGER,
  core_system VARCHAR(100),
  core_system_source core_system_source DEFAULT 'Unknown',
  website VARCHAR(500),
  linkedin_url VARCHAR(500),
  apollo_id VARCHAR(100),
  data_sources TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for payers
CREATE INDEX idx_payers_name ON payers(name);
CREATE INDEX idx_payers_parent_company ON payers(parent_company);
CREATE INDEX idx_payers_states ON payers USING GIN(states);
CREATE INDEX idx_payers_type ON payers(type);
CREATE INDEX idx_payers_apollo_id ON payers(apollo_id);

-- ============================================
-- TPAS TABLE
-- Third Party Administrators
-- ============================================
CREATE TABLE tpas (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  parent_company VARCHAR(255),
  type payer_type DEFAULT 'Other',
  states TEXT[] DEFAULT '{}',
  employee_count INTEGER,
  member_count INTEGER,
  core_system VARCHAR(100),
  core_system_source core_system_source DEFAULT 'Unknown',
  website VARCHAR(500),
  linkedin_url VARCHAR(500),
  apollo_id VARCHAR(100),
  data_sources TEXT[] DEFAULT '{}',
  is_healthcare_focused BOOLEAN DEFAULT FALSE,
  healthcare_keywords_found TEXT[] DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for tpas
CREATE INDEX idx_tpas_name ON tpas(name);
CREATE INDEX idx_tpas_parent_company ON tpas(parent_company);
CREATE INDEX idx_tpas_states ON tpas USING GIN(states);
CREATE INDEX idx_tpas_is_healthcare_focused ON tpas(is_healthcare_focused);
CREATE INDEX idx_tpas_apollo_id ON tpas(apollo_id);

-- ============================================
-- CONTACTS TABLE
-- Decision makers at payers/TPAs
-- ============================================
CREATE TABLE contacts (
  id SERIAL PRIMARY KEY,
  payer_id INTEGER REFERENCES payers(id) ON DELETE SET NULL,
  tpa_id INTEGER REFERENCES tpas(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  title VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  linkedin_url VARCHAR(500),
  source contact_source DEFAULT 'Manual',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Ensure contact is linked to at least one entity
  CONSTRAINT contact_has_entity CHECK (
    payer_id IS NOT NULL OR tpa_id IS NOT NULL
  )
);

-- Indexes for contacts
CREATE INDEX idx_contacts_payer_id ON contacts(payer_id);
CREATE INDEX idx_contacts_tpa_id ON contacts(tpa_id);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE INDEX idx_contacts_name ON contacts(name);

-- ============================================
-- IMPORT_LOGS TABLE
-- Track import history and errors
-- ============================================
CREATE TABLE import_logs (
  id SERIAL PRIMARY KEY,
  source VARCHAR(100) NOT NULL,
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,
  records_found INTEGER DEFAULT 0,
  records_added INTEGER DEFAULT 0,
  records_updated INTEGER DEFAULT 0,
  errors TEXT[] DEFAULT '{}'
);

-- Index for import_logs
CREATE INDEX idx_import_logs_source ON import_logs(source);
CREATE INDEX idx_import_logs_started_at ON import_logs(started_at);

-- ============================================
-- MIGRATIONS TABLE
-- Track which migrations have been run
-- ============================================
CREATE TABLE IF NOT EXISTS migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  executed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to payers table
CREATE TRIGGER update_payers_updated_at
  BEFORE UPDATE ON payers
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Apply trigger to tpas table
CREATE TRIGGER update_tpas_updated_at
  BEFORE UPDATE ON tpas
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
