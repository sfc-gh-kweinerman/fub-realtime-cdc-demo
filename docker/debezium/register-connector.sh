#!/usr/bin/env bash
# Register the Debezium SQL Server CDC connector with Kafka Connect.
# Run this after Debezium is healthy:
#   ./register-connector.sh
#
# The connector captures CDC events from dbo.member_updates, dbo.customers,
# and dbo.accounts in the JackHenry database and publishes them to Redpanda
# topics with the prefix "fub".

set -euo pipefail

CONNECT_URL="${CONNECT_URL:-http://localhost:8083}"

echo "Waiting for Debezium Connect to be ready..."
until curl -sf "${CONNECT_URL}/" > /dev/null 2>&1; do
  sleep 2
done
echo "Debezium Connect is ready."

echo "Registering SQL Server CDC connector..."
curl -sf -X POST "${CONNECT_URL}/connectors/" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -d '{
  "name": "fub-sqlserver-cdc",
  "config": {
    "connector.class": "io.debezium.connector.sqlserver.SqlServerConnector",
    "tasks.max": "1",
    "database.hostname": "sqlserver",
    "database.port": "1433",
    "database.user": "sa",
    "database.password": "FUBDemo!2026",
    "database.names": "JackHenry",
    "topic.prefix": "fub",
    "table.include.list": "dbo.member_updates,dbo.customers,dbo.accounts",
    "schema.history.internal.kafka.bootstrap.servers": "redpanda:29092",
    "schema.history.internal.kafka.topic": "_schema_history",
    "database.encrypt": "false",
    "database.trustServerCertificate": "true",
    "snapshot.mode": "initial",
    "poll.interval.ms": "500",
    "transforms": "unwrap",
    "transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
    "transforms.unwrap.drop.tombstones": "false",
    "transforms.unwrap.delete.handling.mode": "rewrite",
    "transforms.unwrap.add.fields": "op,source.ts_ms"
  }
}'

echo ""
echo "Connector registered. Checking status..."
sleep 3
curl -sf "${CONNECT_URL}/connectors/fub-sqlserver-cdc/status" | python3 -m json.tool 2>/dev/null || \
  curl -sf "${CONNECT_URL}/connectors/fub-sqlserver-cdc/status"

echo ""
echo "Done. CDC topics should appear in Redpanda shortly."
echo "Check Redpanda Console at http://localhost:8090"
