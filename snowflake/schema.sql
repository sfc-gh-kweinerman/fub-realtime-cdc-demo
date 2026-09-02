-- ============================================================
-- First United Bank Demo - Snowflake Schema
-- ============================================================
-- Run this once before starting the CDC poller.
-- Adjust database/schema/warehouse names to match your .env
-- ============================================================

-- Create database and schema if they don't exist
CREATE DATABASE IF NOT EXISTS FUB_DEMO;
CREATE SCHEMA  IF NOT EXISTS FUB_DEMO.BANKING;
CREATE WAREHOUSE IF NOT EXISTS FUB_DEMO_WH
    WAREHOUSE_SIZE = XSMALL
    AUTO_SUSPEND = 300
    AUTO_RESUME = TRUE
    COMMENT = 'FUB demo warehouse';

USE DATABASE FUB_DEMO;
USE SCHEMA   BANKING;
USE WAREHOUSE FUB_DEMO_WH;


-- ── Path A target: standard table (Snowpipe Streaming lands here) ──
-- Append-only immutable transaction ledger.
-- snowflake_ingest_ts is populated by CURRENT_TIMESTAMP() default so
-- we can measure end-to-end SLA: source_write_ts → snowflake_ingest_ts
CREATE TABLE IF NOT EXISTS transactions_landing (
    txn_id              NUMBER,
    account_id          NUMBER,
    txn_type            VARCHAR(20),
    amount              NUMBER(18,2),
    description         VARCHAR(200),
    merchant            VARCHAR(100),
    balance_after       NUMBER(18,2),
    txn_ts              TIMESTAMP_NTZ,
    source_write_ts     TIMESTAMP_NTZ,
    snowflake_ingest_ts TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);


-- ── Path B targets: hybrid tables (direct MERGE, sub-100ms writes) ──

-- Current account state: balance, status updated on every transaction.
-- PRIMARY KEY is mandatory for hybrid tables.
-- source_updated_at = updated_at from SQL Server, used for SLA measurement.
CREATE HYBRID TABLE IF NOT EXISTS accounts_ht (
    account_id          NUMBER          PRIMARY KEY,
    customer_id         NUMBER          NOT NULL,
    account_type        VARCHAR(20),
    balance             NUMBER(18,2),
    status              VARCHAR(10),
    updated_at          TIMESTAMP_NTZ,          -- Snowflake write time
    source_updated_at   TIMESTAMP_NTZ,          -- SQL Server updated_at (for SLA)
    INDEX idx_customer_id (customer_id)
);

-- Current customer profile: address and contact info.
CREATE HYBRID TABLE IF NOT EXISTS customers_ht (
    customer_id         NUMBER          PRIMARY KEY,
    first_name          VARCHAR(50),
    last_name           VARCHAR(50),
    email               VARCHAR(100),
    phone               VARCHAR(20),
    street              VARCHAR(100),
    city                VARCHAR(50),
    state               CHAR(2),
    zip                 CHAR(10),
    updated_at          TIMESTAMP_NTZ,
    source_updated_at   TIMESTAMP_NTZ,
    INDEX idx_name (last_name, first_name)
);


-- ── Demo helper view: Unistore query ──────────────────────────
-- Joins live balance (hybrid table) with full transaction history
-- (standard table) in one SQL statement. This is the "Unistore" story.
CREATE OR REPLACE VIEW account_activity_v AS
SELECT
    a.account_id,
    a.account_type,
    a.balance                                               AS current_balance,
    a.status,
    CONCAT(c.first_name, ' ', c.last_name)                 AS customer_name,
    c.email,
    t.txn_id,
    t.txn_type,
    t.amount,
    t.merchant,
    t.description,
    t.txn_ts,
    t.source_write_ts,
    t.snowflake_ingest_ts,
    -- End-to-end SLA: SQL Server write → Snowflake visible
    DATEDIFF('millisecond', t.source_write_ts, t.snowflake_ingest_ts) AS sla_ms,
    -- Hybrid table write latency
    DATEDIFF('millisecond', a.source_updated_at, a.updated_at)        AS ht_write_ms
FROM accounts_ht a
JOIN customers_ht c  ON a.customer_id  = c.customer_id
JOIN transactions_landing t ON a.account_id = t.account_id;


-- ── Path C target: hybrid table for match-and-merge demo ─────
-- Simulates the "golden member record" that their Dynamic Table currently
-- produces via MERGE on a 1-min refresh. Here we MERGE directly from the
-- consumer (CDC poller / Redpanda Connect sql_raw) for sub-5-sec latency.
-- Secondary indexes make the MERGE ON clause an indexed lookup, not a scan.

CREATE SEQUENCE IF NOT EXISTS member_master_ht_seq START = 1 INCREMENT = 1;

CREATE HYBRID TABLE IF NOT EXISTS member_master_ht (
    member_id           NUMBER          PRIMARY KEY,
    ssn_last4           CHAR(4)         NOT NULL,
    first_name          VARCHAR(50),
    last_name           VARCHAR(50)     NOT NULL,
    email               VARCHAR(100),
    phone               VARCHAR(20),
    street              VARCHAR(100),
    city                VARCHAR(50),
    state               CHAR(2),
    zip                 CHAR(10),
    source_system       VARCHAR(30)     DEFAULT 'CORE',
    updated_at          TIMESTAMP_NTZ,
    source_updated_at   TIMESTAMP_NTZ,
    INDEX idx_ssn_name (ssn_last4, last_name),
    INDEX idx_email (email)
);


-- ── Governance demo: mask SSN last 4 on non-privileged roles ──
-- Uncomment and adjust USING condition when demoing governance.
--
-- CREATE OR REPLACE MASKING POLICY ssn_mask AS (val CHAR(4)) RETURNS CHAR(4) ->
--     CASE
--         WHEN CURRENT_ROLE() IN ('BANKER_ROLE', 'SYSADMIN') THEN val
--         ELSE '****'
--     END;
--
-- ALTER TABLE customers_ht MODIFY COLUMN ssn_last4
--     SET MASKING POLICY ssn_mask;


-- ── Verify ─────────────────────────────────────────────────────
SHOW HYBRID TABLES IN SCHEMA FUB_DEMO.BANKING;
SHOW TABLES       IN SCHEMA FUB_DEMO.BANKING;
