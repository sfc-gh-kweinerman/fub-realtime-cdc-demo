#!/usr/bin/env bash
# --------------------------------------------------------
# setup.sh
# Waits for SQL Server to become ready, then applies
# the JackHenry schema (init.sql).
#
# Usage:
#   bash docker/sqlserver/setup.sh
#
# Run this AFTER: docker compose up -d
# --------------------------------------------------------

set -euo pipefail

SA_PASSWORD="${SA_PASSWORD:-FUBDemo\!2026}"
SERVER="${SQLSERVER_HOST:-localhost},${SQLSERVER_PORT:-1433}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INIT_SQL="${SCRIPT_DIR}/init.sql"

# ---- Check for sqlcmd ----------------------------------------
SQLCMD=""
for candidate in sqlcmd /opt/mssql-tools18/bin/sqlcmd /opt/mssql-tools/bin/sqlcmd; do
    if command -v "$candidate" &>/dev/null; then
        SQLCMD="$candidate"
        break
    fi
done

if [[ -z "$SQLCMD" ]]; then
    echo ""
    echo "sqlcmd not found. Install it with:"
    echo "  macOS:  brew install mssql-tools18"
    echo "  Linux:  see https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-setup-tools"
    echo ""
    echo "Alternatively, connect via:"
    echo "  docker exec -it fub_sqlserver /opt/mssql-tools18/bin/sqlcmd \\"
    echo "    -S localhost -U sa -P '$SA_PASSWORD' -d master -i /tmp/init.sql"
    exit 1
fi

# ---- Wait for SQL Server -------------------------------------
echo "Waiting for SQL Server at $SERVER ..."
RETRIES=30
until "$SQLCMD" -S "$SERVER" -U sa -P "$SA_PASSWORD" -Q "SELECT 1" -No -C &>/dev/null; do
    RETRIES=$((RETRIES - 1))
    if [[ $RETRIES -le 0 ]]; then
        echo "SQL Server did not become ready in time."
        exit 1
    fi
    echo "  Not ready yet, retrying in 3s ... ($RETRIES attempts left)"
    sleep 3
done

echo "SQL Server is ready."

# ---- Apply schema --------------------------------------------
echo "Applying schema from $INIT_SQL ..."
"$SQLCMD" -S "$SERVER" -U sa -P "$SA_PASSWORD" -i "$INIT_SQL" -No -C

echo ""
echo "Setup complete. JackHenry database is ready."
echo ""
echo "Next steps:"
echo "  1. cd streaming && python data_generator.py --seed-only"
echo "     (seeds customers + accounts without starting live generation)"
echo "  2. python cdc_poller.py"
echo "     (starts polling SQL Server and writing to Snowflake)"
echo "  3. python data_generator.py --tps 10"
echo "     (starts generating live transactions)"
