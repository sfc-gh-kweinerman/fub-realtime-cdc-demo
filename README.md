# Real-Time CDC Match-and-Merge Demo

**Redpanda + Snowflake Hybrid Tables**

End-to-end demo showing CDC events flowing from SQL Server through Redpanda into Snowflake Hybrid Tables via direct MERGE, achieving sub-5-second end-to-end latency. Includes a React banking app that serves live account data from the hybrid tables.

---

## What This Demonstrates

| Pattern | How |
|---|---|
| Sub-5-second CDC to queryable | Redpanda Connect `sql_raw` executes MERGE directly into hybrid tables |
| Match-and-merge on secondary keys | MERGE ON indexed columns (ssn_last4 + last_name), not just primary key |
| Hybrid table point reads | Sub-100ms lookups for the application layer |
| Unistore query | Single SQL JOIN across hybrid table (current state) + standard table (history) |
| Full Redpanda pipeline | SQL Server CDC -> Debezium -> Redpanda -> Redpanda Connect -> Snowflake |

### Why Not Dynamic Tables?

Dynamic Tables have a minimum `TARGET_LAG` of 1 minute. For operational CDC workloads that need sub-10-second latency, the `sql_raw` approach bypasses that limitation entirely by executing MERGE from the Redpanda consumer.

### Why Not `snowflake_streaming`?

The Snowpipe Streaming API is INSERT-only and does not support Hybrid Tables as a target. `sql_raw` uses a standard SQL driver connection (same as JDBC/ODBC) which has full DML support: MERGE, UPDATE, DELETE against any table type.

### Architecture

Open `docs/architecture-overview.html` in a browser for the full interactive architecture diagram, latency comparison, and Redpanda Connect config walkthrough.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Docker Desktop | any | [docker.com](https://www.docker.com/products/docker-desktop) |
| Python | 3.11+ | `brew install python` / [python.org](https://www.python.org) |
| Node.js | 18+ | `brew install node` / [nodejs.org](https://nodejs.org) |
| ODBC Driver 18 | -- | see below |
| Snowflake account | hybrid tables enabled | AWS or Azure commercial region |

### Install ODBC Driver 18 (required by PyODBC)

**macOS:**
```bash
brew tap microsoft/mssql-release https://github.com/Microsoft/homebrew-mssql-release
brew update
HOMEBREW_ACCEPT_EULA=Y brew install msodbcsql18 mssql-tools18
```

**Ubuntu / Debian:**
```bash
curl -sSL https://packages.microsoft.com/keys/microsoft.asc | sudo apt-key add -
curl -sSL https://packages.microsoft.com/config/ubuntu/$(lsb_release -rs)/prod.list \
  | sudo tee /etc/apt/sources.list.d/mssql-release.list
sudo apt-get update
sudo ACCEPT_EULA=Y apt-get install -y msodbcsql18 mssql-tools18
```

---

## Setup

### 1. Apply Snowflake Schema

In Snowsight or via SnowSQL, run `snowflake/schema.sql`. This creates:
- `FUB_DEMO.BANKING` database and schema
- `transactions_landing` (standard table)
- `accounts_ht` (hybrid table)
- `customers_ht` (hybrid table)
- `member_master_ht` (hybrid table for match-and-merge demo)
- `member_master_ht_seq` (sequence)
- `account_activity_v` (Unistore demo view)

```bash
# Option A: Snowsight -- paste and run snowflake/schema.sql
# Option B: SnowSQL
snowsql -a YOUR_ACCOUNT -u YOUR_USER -f snowflake/schema.sql
```

### 2. Configure Credentials

**Streaming Python services:**
```bash
cd streaming
cp .env.example .env
# Edit .env: fill in SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_PASSWORD
```

**React app:**
```bash
cd app
cp .env.local.example .env.local
# Edit .env.local: same Snowflake credentials
```

**Redpanda Connect (Snowflake DSN):**
```bash
cd docker/redpanda-connect
cp .env.example .env
# Edit .env: fill in the SNOWFLAKE_DSN connection string
# See .env.example for password and key pair auth formats
```

### 3. Start the Docker Stack

```bash
cd docker
docker compose up -d
```

This starts 5 containers:
- **SQL Server** (port 1433) -- simulates core banking system
- **Redpanda** (port 9092) -- message broker
- **Debezium Connect** (port 8083) -- captures SQL Server CDC -> Redpanda topics
- **Redpanda Connect** (port 4195) -- reads topics, executes sql_raw MERGE -> Snowflake
- **Redpanda Console** (port 8090) -- web UI for viewing topics and messages

Wait for all containers to be healthy:
```bash
docker compose ps
```

### 4. Initialize SQL Server and Register CDC Connector

```bash
# Apply schema and enable CDC
cat sqlserver/init.sql | docker compose exec -T sqlserver \
  /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P 'YOUR_SA_PASSWORD' -No -C -i /dev/stdin

# Register Debezium SQL Server CDC connector
bash debezium/register-connector.sh
```

Verify the connector is running:
```bash
curl -s http://localhost:8083/connectors/fub-sqlserver-cdc/status | python3 -m json.tool
```

### 5. Install Python Dependencies and Start Services

```bash
cd streaming
pip install -r requirements.txt

# Terminal 1: Seed the database
python data_generator.py --seed-only

# Terminal 2: Start the CDC poller
python cdc_poller.py

# Terminal 3: Start the data generator (2 TPS recommended)
python data_generator.py --tps 2
```

### 6. Start the React App

```bash
cd app
npm install
npm run dev
```

### 7. Verify End-to-End

Open these in your browser:

| Service | URL |
|---------|-----|
| **Demo App** | http://localhost:3000 |
| Redpanda Console | http://localhost:8090 |
| Poller Metrics | http://localhost:8080/metrics |
| Generator Status | http://localhost:8081/status |

In Snowflake, verify data is flowing:
```sql
-- Check hybrid table (CDC poller path)
SELECT COUNT(*) FROM FUB_DEMO.BANKING.accounts_ht;

-- Check member match-and-merge (Redpanda Connect path)
SELECT COUNT(*), MAX(updated_at) FROM FUB_DEMO.BANKING.member_master_ht;

-- Check landing table SLA
SELECT ROUND(AVG(DATEDIFF('ms', source_write_ts, snowflake_ingest_ts))/1000.0, 1) AS avg_sla_sec
FROM FUB_DEMO.BANKING.transactions_landing;
```

---

## How It Works

### Two Parallel Write Paths

**Path A: Python CDC Poller (all tables)**

The poller polls SQL Server every 500ms and writes directly to Snowflake:
- `transactions_landing` -- INSERT (standard table, append-only ledger)
- `accounts_ht` / `customers_ht` -- MERGE (hybrid tables, current state)
- `member_master_ht` -- MERGE on secondary keys (hybrid table, match-and-merge)

**Path B: Redpanda Pipeline (member_master_ht)**

SQL Server CDC -> Debezium -> Redpanda topic -> Redpanda Connect `sql_raw` -> MERGE into `member_master_ht`. This path demonstrates the production architecture using Redpanda Connect with zero custom code.

### Redpanda Connect Pipeline

The pipeline config is at `docker/redpanda-connect/pipeline.yaml`. It reads CDC events from the Redpanda topic and routes them:
- Deletes -> `DELETE FROM member_master_ht`
- Inserts/Updates -> `MERGE INTO member_master_ht`

A standalone reference config with full documentation is at `docs/redpanda-connect-reference.yaml`.

---

## Project Structure

```
.
├── docker/
│   ├── docker-compose.yml              All services: SQL Server, Redpanda, Debezium, RP Connect, Console
│   ├── start-demo.sh                   One-command startup script
│   ├── sqlserver/
│   │   └── init.sql                    Jack Henry schema + CDC enablement
│   ├── debezium/
│   │   └── register-connector.sh       Registers SQL Server CDC connector
│   └── redpanda-connect/
│       ├── pipeline.yaml               sql_raw MERGE pipeline config
│       ├── .env.example                Snowflake DSN template
│       └── .env                        Your credentials (gitignored)
│
├── streaming/
│   ├── .env.example                    Config template
│   ├── config.py                       Centralized config from environment
│   ├── data_generator.py              Generates banking data into SQL Server + FastAPI on :8081
│   ├── cdc_poller.py                  Polls SQL Server -> Snowflake write paths + FastAPI on :8080
│   └── requirements.txt
│
├── snowflake/
│   └── schema.sql                      DDL: hybrid tables, standard table, view, sequence
│
├── app/                                Next.js 14 banking demo UI
│   ├── .env.local.example
│   └── src/
│       ├── app/                        Pages: feed, account detail, demo controls
│       ├── components/                 TransactionFeed, AccountCard, LatencyBadge, etc.
│       └── lib/snowflake.ts            Snowflake connection pool
│
└── docs/
    ├── architecture-overview.html      Interactive architecture diagram (open in browser)
    └── redpanda-connect-reference.yaml Annotated production config reference
```

---

## Configuration Reference

### `streaming/.env`

| Variable | Default | Description |
|---|---|---|
| `SQLSERVER_HOST` | `localhost` | SQL Server host |
| `SQLSERVER_PORT` | `1433` | SQL Server port |
| `SQLSERVER_PASSWORD` | -- | SA password (set in docker-compose) |
| `SNOWFLAKE_ACCOUNT` | -- | `orgname-accountname` |
| `SNOWFLAKE_USER` | -- | Snowflake username |
| `SNOWFLAKE_PASSWORD` | -- | Snowflake password (or use key pair) |
| `SNOWFLAKE_PRIVATE_KEY_PATH` | -- | Path to RSA .p8 key for key pair auth |
| `SNOWFLAKE_DATABASE` | `FUB_DEMO` | Target database |
| `SNOWFLAKE_SCHEMA` | `BANKING` | Target schema |
| `SNOWFLAKE_WAREHOUSE` | `FUB_DEMO_WH` | Compute warehouse |
| `DEFAULT_TPS` | `10` | Generator TPS at startup |
| `POLL_INTERVAL_MS` | `500` | CDC poll frequency (ms) |

### `app/.env.local`

| Variable | Description |
|---|---|
| `SNOWFLAKE_ACCOUNT` | Same as streaming |
| `SNOWFLAKE_USER` / `PASSWORD` | Snowflake credentials |
| `MOCK_MODE` | `true` to run UI without Snowflake |
| `POLLER_URL` | `http://localhost:8080` |
| `GENERATOR_URL` | `http://localhost:8081` |

### `docker/redpanda-connect/.env`

| Variable | Description |
|---|---|
| `SNOWFLAKE_DSN` | gosnowflake DSN string (see .env.example for format) |

---

## Key Pair Authentication

If your Snowflake account requires MFA or you want to avoid password auth:

```bash
# Generate key pair
openssl genrsa -out rsa_key.pem 2048
openssl rsa -in rsa_key.pem -pubout -out rsa_key.pub
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in rsa_key.pem -out rsa_key.p8

# Add public key to Snowflake user (run as ACCOUNTADMIN)
ALTER USER YOUR_USER SET RSA_PUBLIC_KEY='<contents of rsa_key.pub without headers>';
```

For the Python services, set `SNOWFLAKE_PRIVATE_KEY_PATH` in `streaming/.env`.

For Redpanda Connect, encode the key for the DSN:
```bash
# macOS (install coreutils: brew install coreutils)
grep -v '^-----' rsa_key.p8 | tr -d '\n' | base64 -D | base64 | tr -d '\n' | tr '+/' '-_' | tr -d '='
```
Then use the key pair DSN format in `docker/redpanda-connect/.env`.

---

## Troubleshooting

**SQL Server container not healthy:**
```bash
docker compose logs sqlserver
```

**Debezium connector not running:**
```bash
curl -s http://localhost:8083/connectors/fub-sqlserver-cdc/status | python3 -m json.tool
# If FAILED, check: docker compose logs debezium
```

**Redpanda Connect auth errors:**
```bash
docker logs fub_rp_connect --tail 20
# "password is empty" -> check SNOWFLAKE_DSN has authenticator=snowflake_jwt for key pair
# "Base64 decode failed" -> re-encode the private key (see Key Pair Authentication above)
# "account locked" -> wait 15 min or run: ALTER USER X SET MINS_TO_UNLOCK = 0
```

**PyODBC "Data source name not found":**
```bash
python -c "import pyodbc; print(pyodbc.drivers())"
# Should include 'ODBC Driver 18 for SQL Server'
```

**Snowflake account identifier format:**
```sql
SELECT CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME();
-- Use this value for SNOWFLAKE_ACCOUNT
```

**Landing table SLA is high:**
The data generator produces faster than the poller can drain. Lower TPS:
```bash
curl -X POST 'http://localhost:8081/tps?tps=2'
```

**Hybrid table "NULL result in a non-nullable column":**
CDC messages with null match keys are being passed to MERGE. The pipeline filters these, but if you modify the schema, ensure NOT NULL columns have defaults or the pipeline mapping handles nulls.

---

## Stopping Everything

```bash
# Stop generator
curl -X POST http://localhost:8081/stop

# Stop Docker stack (preserves data)
cd docker && docker compose stop

# Stop and remove all data
cd docker && docker compose down -v
```
