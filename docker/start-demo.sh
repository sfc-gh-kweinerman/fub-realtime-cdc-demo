#!/usr/bin/env bash
# =============================================================
# FUB Demo: Full Redpanda CDC Pipeline
# =============================================================
# Starts all containers, initializes SQL Server, registers
# the Debezium CDC connector, and prints status.
#
# Usage:
#   cd docker
#   ./start-demo.sh
#
# Prerequisites:
#   - Docker and Docker Compose installed
#   - Copy redpanda-connect/.env.example -> redpanda-connect/.env
#     and fill in your Snowflake DSN
#   - Run snowflake/schema.sql against your Snowflake account first

set -euo pipefail
cd "$(dirname "$0")"

# ── Pre-flight checks ─────────────────────────────────────────
if [ ! -f redpanda-connect/.env ]; then
  echo "ERROR: redpanda-connect/.env not found."
  echo "  cp redpanda-connect/.env.example redpanda-connect/.env"
  echo "  Then fill in your Snowflake DSN."
  exit 1
fi

echo "=== Starting Docker containers ==="
docker compose up -d

# ── Wait for SQL Server ────────────────────────────────────────
echo ""
echo "Waiting for SQL Server to be healthy..."
until docker compose exec -T sqlserver /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P "FUBDemo!2026" -Q "SELECT 1" -No -C > /dev/null 2>&1; do
  sleep 3
  echo "  still waiting..."
done
echo "SQL Server is ready."

# ── Run init.sql (creates tables + enables CDC) ────────────────
echo ""
echo "Running init.sql (schema + CDC setup)..."
docker compose exec -T sqlserver /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P "FUBDemo!2026" -No -C \
  -i /dev/stdin < sqlserver/init.sql
echo "Schema and CDC initialized."

# ── Wait for Debezium ──────────────────────────────────────────
echo ""
echo "Waiting for Debezium Connect to be healthy..."
until curl -sf http://localhost:8083/ > /dev/null 2>&1; do
  sleep 3
  echo "  still waiting..."
done
echo "Debezium Connect is ready."

# ── Register the CDC connector ─────────────────────────────────
echo ""
./debezium/register-connector.sh

# ── Print status ───────────────────────────────────────────────
echo ""
echo "==========================================="
echo "  FUB Demo Stack is running!"
echo "==========================================="
echo ""
echo "Services:"
echo "  SQL Server:        localhost:1433"
echo "  Redpanda Broker:   localhost:9092"
echo "  Debezium Connect:  localhost:8083"
echo "  Redpanda Connect:  localhost:4195/ready"
echo "  Redpanda Console:  http://localhost:8090"
echo ""
echo "Next steps:"
echo "  1. Start the data generator:"
echo "     cd ../streaming && python data_generator.py --tps 10"
echo ""
echo "  2. Watch CDC events flow in Redpanda Console:"
echo "     http://localhost:8090"
echo ""
echo "  3. Check Snowflake hybrid table:"
echo "     SELECT COUNT(*), AVG(DATEDIFF('ms', source_updated_at, updated_at))"
echo "     FROM member_master_ht;"
echo ""
echo "  4. (Optional) Also start the Python CDC poller for comparison:"
echo "     python cdc_poller.py"
echo ""
echo "To stop: docker compose down"
echo "To stop and remove data: docker compose down -v"
