-- ============================================================
-- Jack Henry Core Banking Simulation Schema
-- Mirrors the tables FUB's Jack Henry system would expose
-- via DB2 (production) or SQL Server (this demo)
-- ============================================================

USE master;
GO

IF NOT EXISTS (SELECT name FROM sys.databases WHERE name = 'JackHenry')
    CREATE DATABASE JackHenry;
GO

USE JackHenry;
GO

-- -------------------------------------------------------
-- Customers: personal info, address, contact
-- -------------------------------------------------------
IF OBJECT_ID('dbo.customers', 'U') IS NOT NULL DROP TABLE dbo.customers;
GO
CREATE TABLE dbo.customers (
    customer_id  BIGINT          PRIMARY KEY,
    ssn_last4    CHAR(4)         NOT NULL,
    first_name   VARCHAR(50)     NOT NULL,
    last_name    VARCHAR(50)     NOT NULL,
    email        VARCHAR(100)    NOT NULL,
    phone        VARCHAR(20),
    street       VARCHAR(100),
    city         VARCHAR(50),
    state        CHAR(2),
    zip          CHAR(10),
    member_since DATE            DEFAULT CAST(GETUTCDATE() AS DATE),
    updated_at   DATETIME2(3)    DEFAULT GETUTCDATE()
);
GO

-- -------------------------------------------------------
-- Accounts: deposit, savings, loan accounts
-- -------------------------------------------------------
IF OBJECT_ID('dbo.accounts', 'U') IS NOT NULL DROP TABLE dbo.accounts;
GO
CREATE TABLE dbo.accounts (
    account_id    BIGINT          PRIMARY KEY,
    customer_id   BIGINT          NOT NULL REFERENCES dbo.customers(customer_id),
    account_type  VARCHAR(20)     NOT NULL CHECK (account_type IN ('CHECKING','SAVINGS','LOAN','MONEY_MARKET')),
    balance       DECIMAL(18,2)   NOT NULL DEFAULT 0.00,
    status        VARCHAR(10)     NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
    opened_date   DATE            DEFAULT CAST(GETUTCDATE() AS DATE),
    updated_at    DATETIME2(3)    DEFAULT GETUTCDATE()
);
GO

-- -------------------------------------------------------
-- Transactions: immutable ledger of all account activity
-- source_write_ts is used to measure end-to-end SLA
-- -------------------------------------------------------
IF OBJECT_ID('dbo.transactions', 'U') IS NOT NULL DROP TABLE dbo.transactions;
GO
CREATE TABLE dbo.transactions (
    txn_id          BIGINT          PRIMARY KEY IDENTITY(1,1),
    account_id      BIGINT          NOT NULL REFERENCES dbo.accounts(account_id),
    txn_type        VARCHAR(20)     NOT NULL CHECK (txn_type IN ('DEBIT','DEPOSIT','WITHDRAWAL','TRANSFER_IN','TRANSFER_OUT','FEE','INTEREST')),
    amount          DECIMAL(18,2)   NOT NULL,
    description     VARCHAR(200),
    merchant        VARCHAR(100),
    balance_after   DECIMAL(18,2)   NOT NULL,
    txn_ts          DATETIME2(3)    DEFAULT GETUTCDATE(),
    source_write_ts DATETIME2(3)    DEFAULT GETUTCDATE()
);
GO

-- -------------------------------------------------------
-- Index to support timestamp-based CDC polling
-- -------------------------------------------------------
CREATE INDEX ix_transactions_txn_ts    ON dbo.transactions (txn_ts);
CREATE INDEX ix_accounts_updated_at    ON dbo.accounts     (updated_at);
CREATE INDEX ix_customers_updated_at   ON dbo.customers    (updated_at);
GO

-- -------------------------------------------------------
-- Member updates: simulates an external system (card processor,
-- online banking) sending profile changes keyed by SSN+last_name
-- rather than by our internal customer_id. Demonstrates the
-- "match and merge" pattern the customer's DT currently handles.
-- -------------------------------------------------------
IF OBJECT_ID('dbo.member_updates', 'U') IS NOT NULL DROP TABLE dbo.member_updates;
GO
CREATE TABLE dbo.member_updates (
    update_id       BIGINT          PRIMARY KEY IDENTITY(1,1),
    ssn_last4       CHAR(4)         NOT NULL,
    last_name       VARCHAR(50)     NOT NULL,
    first_name      VARCHAR(50),
    email           VARCHAR(100),
    phone           VARCHAR(20),
    street          VARCHAR(100),
    city            VARCHAR(50),
    state           CHAR(2),
    zip             CHAR(10),
    operation       VARCHAR(10)     NOT NULL DEFAULT 'upsert',
    source_ts       DATETIME2(3)    DEFAULT GETUTCDATE(),
    updated_at      DATETIME2(3)    DEFAULT GETUTCDATE()
);
GO
CREATE INDEX ix_member_updates_ts ON dbo.member_updates (updated_at);
GO

-- -------------------------------------------------------
-- Enable CDC for Debezium / Redpanda Connect pipeline
-- SQL Server CDC requires the database to be enabled first,
-- then each table individually. SQL Server Agent must be
-- running (handled by docker-compose environment vars).
-- -------------------------------------------------------
EXEC sys.sp_cdc_enable_db;
GO

EXEC sys.sp_cdc_enable_table
    @source_schema = N'dbo',
    @source_name   = N'member_updates',
    @role_name     = NULL,
    @supports_net_changes = 1;
GO

EXEC sys.sp_cdc_enable_table
    @source_schema = N'dbo',
    @source_name   = N'customers',
    @role_name     = NULL,
    @supports_net_changes = 1;
GO

EXEC sys.sp_cdc_enable_table
    @source_schema = N'dbo',
    @source_name   = N'accounts',
    @role_name     = NULL,
    @supports_net_changes = 1;
GO

PRINT 'JackHenry schema + CDC enabled successfully.';
GO
