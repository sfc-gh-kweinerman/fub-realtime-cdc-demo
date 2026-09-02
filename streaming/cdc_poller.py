"""
cdc_poller.py
=============
Polls SQL Server for new/changed rows every POLL_INTERVAL_MS milliseconds
and fans out to two Snowflake write paths:

  Path A (optional)  Snowpipe Streaming SDK → transactions_landing
                     Requires key pair auth. Set ENABLE_SNOWPIPE_STREAMING=true.
                     Falls back to direct INSERT when disabled.

  Path B (always on) SQLAlchemy connection pool → direct MERGE into hybrid tables
                     accounts_ht / customers_ht receive sub-100ms writes.

  Path C (always on) Direct MERGE into member_master_ht (hybrid table).
                     Demonstrates match-and-merge on secondary keys (ssn_last4 + last_name)
                     -- the pattern that replaces a Dynamic Table with 1-min lag.

Exposes a FastAPI metrics endpoint on POLLER_PORT for the React demo UI.

Usage:
  python cdc_poller.py
"""

import sys
import time
import threading
import collections
from datetime import datetime, timezone, timedelta
from typing import Optional

import pyodbc
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import create_engine, text

from config import Config

# ── Optional Snowpipe Streaming imports ───────────────────────
_sp_client = None
_sp_channel = None

if Config.ENABLE_SNOWPIPE_STREAMING:
    try:
        from snowflake.ingest import SnowflakeStreamingIngestClient
        from cryptography.hazmat.primitives import serialization
    except ImportError:
        print("WARNING: snowflake-ingest or cryptography not installed. "
              "Disabling Snowpipe Streaming.", file=sys.stderr)
        Config.ENABLE_SNOWPIPE_STREAMING = False  # type: ignore[misc]

# ── Metrics state ─────────────────────────────────────────────
# Rolling window of latencies (ms) – keep last 1 000 samples
_hybrid_latencies: collections.deque = collections.deque(maxlen=1000)
_txn_latencies: collections.deque = collections.deque(maxlen=1000)  # Path A
_merge_latencies: collections.deque = collections.deque(maxlen=1000)  # Path C
_rows_log: collections.deque = collections.deque(maxlen=3600)  # (epoch_sec, count)

_stats = {
    "total_txns_ingested": 0,
    "total_acct_updates": 0,
    "total_cust_updates": 0,
    "total_member_merges": 0,
    "member_matched": 0,
    "member_inserted": 0,
    "errors": 0,
    "start_time": time.time(),
    "poller_running": False,
}

# ── Timestamp watermarks (used for change detection polling) ──
_watermarks = {
    "txn_ts": None,
    "acct_ts": None,
    "cust_ts": None,
    "member_ts": None,
}


# ── Snowflake SQLAlchemy engine (Path B) ──────────────────────
def _build_sf_engine():
    from cryptography.hazmat.primitives import serialization as _ser

    connect_args: dict = {
        "account": Config.SNOWFLAKE_ACCOUNT,
        "user": Config.SNOWFLAKE_USER,
        "database": Config.SNOWFLAKE_DATABASE,
        "schema": Config.SNOWFLAKE_SCHEMA,
        "warehouse": Config.SNOWFLAKE_WAREHOUSE,
    }

    # Prefer key pair auth (bypasses MFA); fall back to password
    key_path = Config.SNOWFLAKE_PRIVATE_KEY_PATH
    if key_path:
        with open(key_path, "rb") as f:
            passphrase = Config.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE.encode() or None
            pk = _ser.load_pem_private_key(f.read(), password=passphrase)
        connect_args["private_key"] = pk.private_bytes(
            encoding=_ser.Encoding.DER,
            format=_ser.PrivateFormat.PKCS8,
            encryption_algorithm=_ser.NoEncryption(),
        )
    else:
        connect_args["password"] = Config.SNOWFLAKE_PASSWORD

    return create_engine(
        f"snowflake://{Config.SNOWFLAKE_USER}@{Config.SNOWFLAKE_ACCOUNT}"
        f"/{Config.SNOWFLAKE_DATABASE}/{Config.SNOWFLAKE_SCHEMA}"
        f"?warehouse={Config.SNOWFLAKE_WAREHOUSE}",
        pool_size=4,
        max_overflow=2,
        pool_pre_ping=True,
        pool_recycle=1800,
        connect_args=connect_args,
    )


_sf_engine = None


def get_sf_engine():
    global _sf_engine
    if _sf_engine is None:
        _sf_engine = _build_sf_engine()
    return _sf_engine


# ── Snowpipe Streaming setup (Path A) ─────────────────────────
def _init_snowpipe_streaming():
    global _sp_client, _sp_channel
    if not Config.ENABLE_SNOWPIPE_STREAMING:
        return

    key_path = Config.SNOWFLAKE_PRIVATE_KEY_PATH
    if not key_path:
        print("SNOWFLAKE_PRIVATE_KEY_PATH not set. Disabling Snowpipe Streaming.",
              file=sys.stderr)
        Config.ENABLE_SNOWPIPE_STREAMING = False  # type: ignore[misc]
        return

    try:
        passphrase = Config.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE.encode() or None
        with open(key_path, "rb") as f:
            private_key = serialization.load_pem_private_key(f.read(), password=passphrase)
        private_key_bytes = private_key.private_bytes(
            encoding=serialization.Encoding.DER,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        _sp_client = SnowflakeStreamingIngestClient(
            name="fub_demo_poller",
            account=Config.SNOWFLAKE_ACCOUNT,
            user=Config.SNOWFLAKE_USER,
            private_key=private_key_bytes,
        )
        _sp_channel = _sp_client.open_channel(
            channel_name="fub_txn_channel_v1",
            database=Config.SNOWFLAKE_DATABASE,
            schema=Config.SNOWFLAKE_SCHEMA,
            table="TRANSACTIONS_LANDING",
            on_error="continue",
        )
        print(f"  Snowpipe Streaming channel opened: fub_txn_channel_v1")
    except Exception as exc:
        print(f"  ERROR: Could not init Snowpipe Streaming: {exc}", file=sys.stderr)
        Config.ENABLE_SNOWPIPE_STREAMING = False  # type: ignore[misc]


# ── SQL Server connection ──────────────────────────────────────
def get_ss_conn() -> pyodbc.Connection:
    return pyodbc.connect(Config.sqlserver_conn_str(), autocommit=True)


# ── MERGE statements (Path B) ─────────────────────────────────
MERGE_ACCOUNTS = text("""
MERGE INTO accounts_ht AS tgt
USING (
    SELECT
        :account_id    AS account_id,
        :customer_id   AS customer_id,
        :account_type  AS account_type,
        :balance       AS balance,
        :status        AS status,
        :updated_at    AS updated_at,
        :src_updated   AS source_updated_at
) AS src
ON tgt.account_id = src.account_id
WHEN MATCHED THEN UPDATE SET
    tgt.balance           = src.balance,
    tgt.status            = src.status,
    tgt.updated_at        = CURRENT_TIMESTAMP(),
    tgt.source_updated_at = src.source_updated_at
WHEN NOT MATCHED THEN INSERT
    (account_id, customer_id, account_type, balance, status, updated_at, source_updated_at)
    VALUES
    (src.account_id, src.customer_id, src.account_type,
     src.balance, src.status, CURRENT_TIMESTAMP(), src.source_updated_at)
""")

MERGE_CUSTOMERS = text("""
MERGE INTO customers_ht AS tgt
USING (
    SELECT
        :customer_id AS customer_id,
        :first_name  AS first_name,
        :last_name   AS last_name,
        :email       AS email,
        :phone       AS phone,
        :street      AS street,
        :city        AS city,
        :state       AS state,
        :zip         AS zip,
        :src_updated AS source_updated_at
) AS src
ON tgt.customer_id = src.customer_id
WHEN MATCHED THEN UPDATE SET
    tgt.first_name        = src.first_name,
    tgt.last_name         = src.last_name,
    tgt.email             = src.email,
    tgt.phone             = src.phone,
    tgt.street            = src.street,
    tgt.city              = src.city,
    tgt.state             = src.state,
    tgt.zip               = src.zip,
    tgt.updated_at        = CURRENT_TIMESTAMP(),
    tgt.source_updated_at = src.source_updated_at
WHEN NOT MATCHED THEN INSERT
    (customer_id, first_name, last_name, email, phone,
     street, city, state, zip, updated_at, source_updated_at)
    VALUES
    (src.customer_id, src.first_name, src.last_name, src.email, src.phone,
     src.street, src.city, src.state, src.zip, CURRENT_TIMESTAMP(),
     src.source_updated_at)
""")

MERGE_MEMBER = text("""
MERGE INTO member_master_ht AS tgt
USING (
    SELECT
        :ssn_last4   AS ssn_last4,
        :last_name   AS last_name,
        :first_name  AS first_name,
        :email       AS email,
        :phone       AS phone,
        :street      AS street,
        :city        AS city,
        :state       AS state,
        :zip         AS zip,
        :source_ts   AS source_ts
) AS src
ON tgt.ssn_last4 = src.ssn_last4 AND tgt.last_name = src.last_name
WHEN MATCHED THEN UPDATE SET
    tgt.first_name        = COALESCE(src.first_name, tgt.first_name),
    tgt.email             = COALESCE(src.email, tgt.email),
    tgt.phone             = COALESCE(src.phone, tgt.phone),
    tgt.street            = COALESCE(src.street, tgt.street),
    tgt.city              = COALESCE(src.city, tgt.city),
    tgt.state             = COALESCE(src.state, tgt.state),
    tgt.zip               = COALESCE(src.zip, tgt.zip),
    tgt.source_system     = 'EXTERNAL',
    tgt.updated_at        = CURRENT_TIMESTAMP(),
    tgt.source_updated_at = src.source_ts
WHEN NOT MATCHED THEN INSERT
    (member_id, ssn_last4, last_name, first_name, email, phone,
     street, city, state, zip, source_system, updated_at, source_updated_at)
    VALUES
    (member_master_ht_seq.NEXTVAL, src.ssn_last4, src.last_name, src.first_name,
     src.email, src.phone, src.street, src.city, src.state, src.zip,
     'EXTERNAL', CURRENT_TIMESTAMP(), src.source_ts)
""")


INSERT_TRANSACTIONS_LANDING = text("""
INSERT INTO transactions_landing
    (txn_id, account_id, txn_type, amount, description, merchant,
     balance_after, txn_ts, source_write_ts)
VALUES
    (:txn_id, :account_id, :txn_type, :amount, :description, :merchant,
     :balance_after, :txn_ts, :source_write_ts)
""")


# ── Polling logic ─────────────────────────────────────────────
def _init_watermarks(ss_conn: pyodbc.Connection):
    """Start 5 minutes in the past to catch up on any existing data."""
    # Use naive UTC to match SQL Server's GETUTCDATE() values
    # Accounts and customers are PRE-SEEDED - only catch changes from NOW
    now_utc = datetime.now(timezone.utc).replace(tzinfo=None)
    cutoff = now_utc - timedelta(seconds=10)
    _watermarks["txn_ts"] = cutoff
    _watermarks["acct_ts"] = now_utc  # skip existing accounts (pre-seeded)
    _watermarks["cust_ts"] = now_utc  # skip existing customers (pre-seeded)
    _watermarks["member_ts"] = now_utc  # member_updates generated at runtime

    # If tables are empty, set to epoch so we get everything
    cursor = ss_conn.cursor()
    cursor.execute("SELECT MIN(txn_ts) FROM dbo.transactions")
    row = cursor.fetchone()
    if row and row[0]:
        first_ts = row[0]
        _watermarks["txn_ts"] = min(_watermarks["txn_ts"], first_ts - timedelta(seconds=1))


def _poll_transactions(ss_conn: pyodbc.Connection) -> list[dict]:
    cursor = ss_conn.cursor()
    cursor.execute(
        """SELECT txn_id, account_id, txn_type, amount, description, merchant,
                  balance_after, txn_ts, source_write_ts
           FROM dbo.transactions
           WHERE txn_ts > ?
           ORDER BY txn_ts ASC
           OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY""",
        _watermarks["txn_ts"],
    )
    rows = cursor.fetchall()
    if rows:
        _watermarks["txn_ts"] = rows[-1].txn_ts
    return [
        {
            "txn_id": r.txn_id,
            "account_id": r.account_id,
            "txn_type": r.txn_type,
            "amount": float(r.amount),
            "description": r.description or "",
            "merchant": r.merchant or "",
            "balance_after": float(r.balance_after),
            "txn_ts": r.txn_ts.isoformat() if r.txn_ts else None,
            "source_write_ts": r.source_write_ts.isoformat() if r.source_write_ts else None,
        }
        for r in rows
    ]


def _poll_accounts(ss_conn: pyodbc.Connection) -> list[dict]:
    cursor = ss_conn.cursor()
    cursor.execute(
        """SELECT account_id, customer_id, account_type, balance, status, updated_at
           FROM dbo.accounts
           WHERE updated_at > ?
           ORDER BY updated_at ASC
           OFFSET 0 ROWS FETCH NEXT 30 ROWS ONLY""",
        _watermarks["acct_ts"],
    )
    rows = cursor.fetchall()
    if rows:
        _watermarks["acct_ts"] = rows[-1].updated_at
    return [
        {
            "account_id": int(r.account_id),
            "customer_id": int(r.customer_id),
            "account_type": r.account_type,
            "balance": float(r.balance),
            "status": r.status,
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }
        for r in rows
    ]


def _poll_customers(ss_conn: pyodbc.Connection) -> list[dict]:
    cursor = ss_conn.cursor()
    cursor.execute(
        """SELECT customer_id, first_name, last_name, email, phone,
                  street, city, state, zip, updated_at
           FROM dbo.customers
           WHERE updated_at > ?
           ORDER BY updated_at ASC
           OFFSET 0 ROWS FETCH NEXT 30 ROWS ONLY""",
        _watermarks["cust_ts"],
    )
    rows = cursor.fetchall()
    if rows:
        _watermarks["cust_ts"] = rows[-1].updated_at
    return [
        {
            "customer_id": int(r.customer_id),
            "first_name": r.first_name,
            "last_name": r.last_name,
            "email": r.email or "",
            "phone": r.phone or "",
            "street": r.street or "",
            "city": r.city or "",
            "state": r.state or "",
            "zip": r.zip or "",
            "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        }
        for r in rows
    ]


# ── Snowflake write helpers ────────────────────────────────────
def _write_transactions_path_a(txn_rows: list[dict]):
    """Path A: Snowpipe Streaming SDK → transactions_landing."""
    if not txn_rows:
        return

    t0 = time.perf_counter()
    if Config.ENABLE_SNOWPIPE_STREAMING and _sp_channel:
        # Prepare rows with UPPERCASE column names for Snowpipe Streaming
        sp_rows = [
            {
                "TXN_ID": r["txn_id"],
                "ACCOUNT_ID": r["account_id"],
                "TXN_TYPE": r["txn_type"],
                "AMOUNT": r["amount"],
                "DESCRIPTION": r["description"],
                "MERCHANT": r["merchant"],
                "BALANCE_AFTER": r["balance_after"],
                "TXN_TS": r["txn_ts"],
                "SOURCE_WRITE_TS": r["source_write_ts"],
            }
            for r in txn_rows
        ]
        _sp_channel.insert_rows(sp_rows)
    else:
        # Multi-row INSERT in a single SQL statement (one roundtrip)
        if not txn_rows:
            return
        values_parts = []
        for r in txn_rows:
            desc = str(r["description"]).replace("'", "''")
            merch = str(r["merchant"]).replace("'", "''")
            values_parts.append(
                f"({r['txn_id']}, {r['account_id']}, '{r['txn_type']}', "
                f"{r['amount']}, '{desc}', '{merch}', "
                f"{r['balance_after']}, '{r['txn_ts']}', '{r['source_write_ts']}')"
            )
        sql = (
            "INSERT INTO transactions_landing "
            "(txn_id, account_id, txn_type, amount, description, merchant, "
            "balance_after, txn_ts, source_write_ts) "
            f"SELECT * FROM VALUES {', '.join(values_parts)}"
        )
        with get_sf_engine().connect() as conn:
            conn.execute(text(sql))
            conn.commit()

    elapsed_ms = (time.perf_counter() - t0) * 1000
    _txn_latencies.append(elapsed_ms)
    _stats["total_txns_ingested"] += len(txn_rows)
    _rows_log.append((int(time.time()), len(txn_rows)))


def _write_accounts_path_b(acct_rows: list[dict]):
    """Path B: Direct MERGE → accounts_ht."""
    if not acct_rows:
        return

    t0 = time.perf_counter()
    with get_sf_engine().connect() as conn:
        for r in acct_rows:
            conn.execute(
                MERGE_ACCOUNTS,
                {
                    "account_id": r["account_id"],
                    "customer_id": r["customer_id"],
                    "account_type": r["account_type"],
                    "balance": r["balance"],
                    "status": r["status"],
                    "updated_at": r["updated_at"],
                    "src_updated": r["updated_at"],
                },
            )
        conn.commit()
    elapsed_ms = (time.perf_counter() - t0) * 1000
    _hybrid_latencies.append(elapsed_ms / max(len(acct_rows), 1))
    _stats["total_acct_updates"] += len(acct_rows)


def _write_customers_path_b(cust_rows: list[dict]):
    """Path B: Direct MERGE → customers_ht."""
    if not cust_rows:
        return

    with get_sf_engine().connect() as conn:
        for r in cust_rows:
            conn.execute(
                MERGE_CUSTOMERS,
                {
                    "customer_id": r["customer_id"],
                    "first_name": r["first_name"],
                    "last_name": r["last_name"],
                    "email": r["email"],
                    "phone": r["phone"],
                    "street": r["street"],
                    "city": r["city"],
                    "state": r["state"],
                    "zip": r["zip"],
                    "src_updated": r["updated_at"],
                },
            )
        conn.commit()
    _stats["total_cust_updates"] += len(cust_rows)


def _poll_member_updates(ss_conn: pyodbc.Connection) -> list[dict]:
    """Path C: Poll external member updates for match-and-merge."""
    cursor = ss_conn.cursor()
    cursor.execute(
        """SELECT update_id, ssn_last4, last_name, first_name, email, phone,
                  street, city, state, zip, operation, source_ts, updated_at
           FROM dbo.member_updates
           WHERE updated_at > ?
           ORDER BY updated_at ASC
           OFFSET 0 ROWS FETCH NEXT 30 ROWS ONLY""",
        _watermarks["member_ts"],
    )
    rows = cursor.fetchall()
    if rows:
        _watermarks["member_ts"] = rows[-1].updated_at
    return [
        {
            "ssn_last4": r.ssn_last4.strip() if r.ssn_last4 else "",
            "last_name": r.last_name or "",
            "first_name": r.first_name or "",
            "email": r.email or "",
            "phone": r.phone or "",
            "street": r.street or "",
            "city": r.city or "",
            "state": r.state or "",
            "zip": r.zip or "",
            "operation": r.operation or "upsert",
            "source_ts": r.source_ts.isoformat() if r.source_ts else None,
        }
        for r in rows
    ]


def _write_member_merge(member_rows: list[dict]):
    """Path C: Direct MERGE into member_master_ht (match on ssn_last4 + last_name)."""
    if not member_rows:
        return

    t0 = time.perf_counter()
    with get_sf_engine().connect() as conn:
        for r in member_rows:
            if r["operation"] == "delete":
                conn.execute(
                    text("DELETE FROM member_master_ht WHERE ssn_last4 = :ssn AND last_name = :ln"),
                    {"ssn": r["ssn_last4"], "ln": r["last_name"]},
                )
            else:
                result = conn.execute(
                    MERGE_MEMBER,
                    {
                        "ssn_last4": r["ssn_last4"],
                        "last_name": r["last_name"],
                        "first_name": r["first_name"] or None,
                        "email": r["email"] or None,
                        "phone": r["phone"] or None,
                        "street": r["street"] or None,
                        "city": r["city"] or None,
                        "state": r["state"] or None,
                        "zip": r["zip"] or None,
                        "source_ts": r["source_ts"],
                    },
                )
                if result.rowcount == 1:
                    _stats["member_matched"] += 1
                else:
                    _stats["member_inserted"] += 1
        conn.commit()
    elapsed_ms = (time.perf_counter() - t0) * 1000
    _merge_latencies.append(elapsed_ms / max(len(member_rows), 1))
    _stats["total_member_merges"] += len(member_rows)


# ── Main poll loop ────────────────────────────────────────────
def run_poller():
    _stats["poller_running"] = True
    interval = Config.POLL_INTERVAL_MS / 1000.0

    print("Connecting to SQL Server...")
    ss_conn = get_ss_conn()
    print(f"  Connected: {Config.SQLSERVER_HOST}:{Config.SQLSERVER_PORT}")

    print("Connecting to Snowflake (SQLAlchemy)...")
    try:
        with get_sf_engine().connect() as conn:
            conn.execute(text("SELECT CURRENT_VERSION()"))
        print(f"  Connected: {Config.SNOWFLAKE_ACCOUNT}/{Config.SNOWFLAKE_DATABASE}")
    except Exception as exc:
        print(f"  WARNING: Snowflake connection failed: {exc}", file=sys.stderr)
        print("  Poller will retry on each poll cycle.", file=sys.stderr)

    if Config.ENABLE_SNOWPIPE_STREAMING:
        print("Initializing Snowpipe Streaming...")
        _init_snowpipe_streaming()
        status = "enabled" if Config.ENABLE_SNOWPIPE_STREAMING else "disabled (fallback to direct INSERT)"
        print(f"  Snowpipe Streaming: {status}")
    else:
        print("  Snowpipe Streaming: disabled (using direct INSERT for transactions_landing)")

    _init_watermarks(ss_conn)
    print(f"Starting poll loop (interval: {Config.POLL_INTERVAL_MS}ms). Ctrl-C to stop.")

    while True:
        tick_start = time.perf_counter()

        try:
            txn_rows = _poll_transactions(ss_conn)
            acct_rows = _poll_accounts(ss_conn)
            cust_rows = _poll_customers(ss_conn)
            member_rows = _poll_member_updates(ss_conn)

            if txn_rows or acct_rows or cust_rows or member_rows:
                print(
                    f"  [{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] "
                    f"txns={len(txn_rows)} accts={len(acct_rows)} custs={len(cust_rows)} members={len(member_rows)}"
                )

            if txn_rows:
                _write_transactions_path_a(txn_rows)
            if acct_rows:
                _write_accounts_path_b(acct_rows)
            if cust_rows:
                _write_customers_path_b(cust_rows)
            if member_rows:
                _write_member_merge(member_rows)

        except pyodbc.Error as exc:
            _stats["errors"] += 1
            print(f"  [poller] SQL Server error: {exc}", file=sys.stderr)
            try:
                ss_conn = get_ss_conn()
            except Exception:
                pass
        except Exception as exc:
            _stats["errors"] += 1
            print(f"  [poller] Error: {exc}", file=sys.stderr)

        elapsed = time.perf_counter() - tick_start
        sleep_time = max(0.0, interval - elapsed)
        time.sleep(sleep_time)


# ── FastAPI metrics endpoint ───────────────────────────────────
api = FastAPI(title="FUB CDC Poller Metrics")
api.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _percentile(data: list[float], p: int) -> Optional[float]:
    if not data:
        return None
    sorted_data = sorted(data)
    idx = int(len(sorted_data) * p / 100)
    return round(sorted_data[min(idx, len(sorted_data) - 1)], 1)


@api.get("/metrics")
def metrics():
    now = int(time.time())
    rows_last_60 = sum(c for ts, c in _rows_log if now - ts <= 60)
    rows_last_5 = sum(c for ts, c in _rows_log if now - ts <= 5)
    hybrid_list = list(_hybrid_latencies)
    txn_list = list(_txn_latencies)
    merge_list = list(_merge_latencies)
    uptime = time.time() - _stats["start_time"]

    return {
        "poller_running": _stats["poller_running"],
        "snowpipe_streaming_enabled": Config.ENABLE_SNOWPIPE_STREAMING,
        "hybrid_write_p50_ms": _percentile(hybrid_list, 50),
        "hybrid_write_p95_ms": _percentile(hybrid_list, 95),
        "hybrid_write_p99_ms": _percentile(hybrid_list, 99),
        "txn_ingest_p50_ms": _percentile(txn_list, 50),
        "txn_ingest_p95_ms": _percentile(txn_list, 95),
        "merge_match_p50_ms": _percentile(merge_list, 50),
        "merge_match_p95_ms": _percentile(merge_list, 95),
        "merge_total": _stats["total_member_merges"],
        "merge_matched": _stats["member_matched"],
        "merge_inserted": _stats["member_inserted"],
        "rows_last_60s": rows_last_60,
        "rows_last_5s": rows_last_5,
        "tps_last_5s": round(rows_last_5 / 5, 1),
        "total_txns_ingested": _stats["total_txns_ingested"],
        "total_acct_updates": _stats["total_acct_updates"],
        "total_cust_updates": _stats["total_cust_updates"],
        "errors": _stats["errors"],
        "uptime_s": round(uptime, 0),
        "poll_interval_ms": Config.POLL_INTERVAL_MS,
    }


@api.get("/health")
def health():
    return {"status": "ok"}


@api.get("/recent")
def recent_from_source():
    """Returns the last 20 transactions from SQL Server for the pipeline monitor."""
    try:
        conn = get_ss_conn()
        cursor = conn.cursor()
        cursor.execute("""
            SELECT TOP 20 txn_id, account_id, txn_type, amount, merchant,
                   balance_after, txn_ts, source_write_ts
            FROM dbo.transactions
            ORDER BY txn_ts DESC
        """)
        rows = cursor.fetchall()
        conn.close()
        return [
            {
                "txn_id": r.txn_id,
                "account_id": r.account_id,
                "txn_type": r.txn_type,
                "amount": float(r.amount),
                "merchant": r.merchant or "",
                "balance_after": float(r.balance_after),
                "txn_ts": r.txn_ts.isoformat() if r.txn_ts else None,
                "source_write_ts": r.source_write_ts.isoformat() if r.source_write_ts else None,
            }
            for r in rows
        ]
    except Exception as exc:
        return {"error": str(exc)}


def main():
    api_thread = threading.Thread(
        target=lambda: uvicorn.run(
            api,
            host="0.0.0.0",
            port=Config.POLLER_PORT,
            log_level="warning",
        ),
        daemon=True,
    )
    api_thread.start()
    print(f"Poller metrics API: http://localhost:{Config.POLLER_PORT}/metrics")

    run_poller()


if __name__ == "__main__":
    main()
