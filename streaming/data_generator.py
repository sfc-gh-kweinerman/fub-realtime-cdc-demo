"""
data_generator.py
=================
Generates realistic Jack Henry core banking data into SQL Server.

Two modes:
  --seed-only   Insert customers + accounts once, then exit.
  --tps N       Seed if needed, then generate N transactions/second continuously.

Also exposes an HTTP control API (FastAPI) on GENERATOR_PORT so the React
demo control panel can start/stop generation and change TPS at runtime.

Usage:
  python data_generator.py --tps 10
  python data_generator.py --seed-only
"""

import argparse
import asyncio
import random
import sys
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pyodbc
import uvicorn
from faker import Faker
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from config import Config

# ── Globals (shared between FastAPI and generation loop) ───────
fake = Faker("en_US")
rng = np.random.default_rng()

_running = False
_current_tps = Config.DEFAULT_TPS
_stats = {
    "total_transactions": 0,
    "total_account_updates": 0,
    "total_customer_updates": 0,
    "start_time": None,
    "errors": 0,
}

# In-memory account state to keep balances consistent
# {account_id: {"balance": float, "type": str, "customer_id": int}}
_accounts: dict[int, dict] = {}

# ── Merchant/description data ──────────────────────────────────
DEBIT_MERCHANTS = [
    "Starbucks Coffee", "McDonald's", "Shell Gas Station", "Walmart Supercenter",
    "Amazon.com", "Target", "CVS Pharmacy", "Home Depot", "Chipotle Mexican Grill",
    "Whole Foods Market", "Kroger", "Publix", "Costco Wholesale", "Walgreens",
    "Apple Pay", "Uber", "DoorDash", "Grubhub", "Netflix", "Spotify Premium",
    "Delta Airlines", "Marriott Hotels", "Cheesecake Factory", "Best Buy",
    "Dick's Sporting Goods", "TJ Maxx", "Lowe's", "Panera Bread", "Chick-fil-A",
]
DEPOSIT_DESCRIPTIONS = [
    "Payroll Direct Deposit", "ACH Transfer In", "Mobile Check Deposit",
    "IRS Tax Refund", "Zelle Transfer Received", "Wire Transfer Received",
    "Social Security Payment", "Dividend Payment", "Rental Income",
]
ATM_AMOUNTS = [20, 40, 60, 80, 100, 120, 140, 160, 200, 300, 400, 500]
FEE_DESCRIPTIONS = [
    "Monthly Service Fee", "Overdraft Protection Fee",
    "Wire Transfer Fee", "Foreign Transaction Fee",
]


# ── SQL helpers ────────────────────────────────────────────────
def get_connection() -> pyodbc.Connection:
    return pyodbc.connect(Config.sqlserver_conn_str(), autocommit=False)


def seed_database(conn: pyodbc.Connection) -> bool:
    """Returns True if seed was needed, False if already seeded."""
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM dbo.customers")
    count = cursor.fetchone()[0]
    if count >= Config.SEED_CUSTOMERS:
        print(f"  Database already seeded ({count} customers). Skipping.")
        return False

    print(f"  Seeding {Config.SEED_CUSTOMERS} customers and {Config.SEED_ACCOUNTS} accounts...")

    # ── Customers ──────────────────────────────────────────────
    customers = []
    for i in range(1, Config.SEED_CUSTOMERS + 1):
        profile = fake.profile(fields=["name", "address", "mail"])
        name_parts = profile["name"].split(" ", 1)
        first = name_parts[0]
        last = name_parts[1] if len(name_parts) > 1 else "Smith"
        addr = fake.address().split("\n")
        street = addr[0]
        city_state_zip = addr[1] if len(addr) > 1 else "Unknown, CA 90210"
        # Parse city, state zip
        try:
            city_part, state_zip = city_state_zip.rsplit(",", 1)
            state_zip = state_zip.strip()
            state = state_zip[:2]
            zip_code = state_zip[3:] if len(state_zip) > 3 else "00000"
        except Exception:
            city_part, state, zip_code = "Anytown", "CA", "90210"

        customers.append((
            i,
            str(random.randint(1000, 9999)),
            first[:50],
            last[:50],
            fake.email(),
            fake.phone_number()[:20],
            street[:100],
            city_part.strip()[:50],
            state[:2],
            zip_code[:10],
        ))

    cursor.executemany(
        """INSERT INTO dbo.customers
           (customer_id, ssn_last4, first_name, last_name, email, phone,
            street, city, state, zip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        customers,
    )
    conn.commit()

    # ── Accounts ───────────────────────────────────────────────
    account_id = 1000
    accounts_to_insert = []
    account_types_pool = (
        ["CHECKING"] * 50
        + ["SAVINGS"] * 30
        + ["CHECKING", "SAVINGS"] * 20  # pairs for same customer
        + ["LOAN"] * 10
        + ["MONEY_MARKET"] * 10
        + ["CHECKING"] * 30  # extra checking to hit ~150
    )
    # Simple approach: give every customer 1 checking, random extras
    for cust_id in range(1, Config.SEED_CUSTOMERS + 1):
        # Checking always
        balance = round(float(rng.lognormal(mean=8.5, sigma=0.9)), 2)  # ~$1k-$25k
        balance = max(balance, 50.0)
        accounts_to_insert.append((account_id, cust_id, "CHECKING", balance, "ACTIVE"))
        _accounts[account_id] = {"balance": balance, "type": "CHECKING", "customer_id": cust_id}
        account_id += 1

        if len(accounts_to_insert) >= Config.SEED_ACCOUNTS:
            break

        # ~50% get a savings account too
        if random.random() < 0.5 and len(accounts_to_insert) < Config.SEED_ACCOUNTS:
            savings_bal = round(float(rng.lognormal(mean=9.5, sigma=1.0)), 2)  # ~$5k-$100k
            accounts_to_insert.append((account_id, cust_id, "SAVINGS", savings_bal, "ACTIVE"))
            _accounts[account_id] = {"balance": savings_bal, "type": "SAVINGS", "customer_id": cust_id}
            account_id += 1

    cursor.executemany(
        """INSERT INTO dbo.accounts
           (account_id, customer_id, account_type, balance, status)
           VALUES (?, ?, ?, ?, ?)""",
        accounts_to_insert,
    )
    conn.commit()

    print(f"  Seeded {len(customers)} customers and {len(accounts_to_insert)} accounts.")
    return True


def _load_accounts_into_memory(conn: pyodbc.Connection):
    """Load current account state into _accounts dict."""
    global _accounts
    cursor = conn.cursor()
    cursor.execute("SELECT account_id, customer_id, account_type, balance FROM dbo.accounts")
    for row in cursor.fetchall():
        _accounts[row.account_id] = {
            "balance": float(row.balance),
            "type": row.account_type,
            "customer_id": row.customer_id,
        }


def _generate_transaction(account_id: int, acct: dict) -> Optional[dict]:
    """Generate one transaction for the given account."""
    acct_type = acct["type"]
    balance = acct["balance"]

    # Weight transaction types by account type
    if acct_type == "LOAN":
        txn_type = random.choices(
            ["DEPOSIT", "FEE", "INTEREST"],
            weights=[70, 20, 10],
        )[0]
    elif acct_type == "SAVINGS":
        txn_type = random.choices(
            ["DEPOSIT", "WITHDRAWAL", "INTEREST", "TRANSFER_IN", "TRANSFER_OUT"],
            weights=[35, 20, 15, 20, 10],
        )[0]
    else:  # CHECKING, MONEY_MARKET
        txn_type = random.choices(
            ["DEBIT", "DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "TRANSFER_OUT", "FEE"],
            weights=[55, 20, 12, 6, 5, 2],
        )[0]

    # Generate amount
    if txn_type == "DEBIT":
        amount = round(float(rng.lognormal(mean=3.8, sigma=0.85)), 2)
        amount = max(1.50, min(amount, 500.0))
        merchant = random.choice(DEBIT_MERCHANTS)
        description = f"POS Purchase - {merchant}"
        amount = -amount
    elif txn_type == "DEPOSIT":
        amount = round(float(rng.lognormal(mean=7.3, sigma=0.6)), 2)
        amount = max(50.0, min(amount, 10_000.0))
        description = random.choice(DEPOSIT_DESCRIPTIONS)
        merchant = description.split(" ")[0]
    elif txn_type == "WITHDRAWAL":
        amount = float(random.choice(ATM_AMOUNTS))
        description = "ATM Withdrawal"
        merchant = "ATM"
        amount = -amount
    elif txn_type == "FEE":
        amount = -round(random.uniform(15, 35), 2)
        description = random.choice(FEE_DESCRIPTIONS)
        merchant = "First United Bank"
    elif txn_type == "INTEREST":
        amount = round(balance * 0.0001, 2)
        amount = max(0.01, amount)
        description = "Interest Payment"
        merchant = "First United Bank"
    elif txn_type in ("TRANSFER_IN", "TRANSFER_OUT"):
        amount = round(float(rng.lognormal(mean=6.5, sigma=0.7)), 2)
        amount = max(10.0, min(amount, 5_000.0))
        description = "Internal Account Transfer"
        merchant = "First United Bank"
        if txn_type == "TRANSFER_OUT":
            amount = -amount
    else:
        return None

    new_balance = round(balance + amount, 2)
    # Avoid negative balance for deposit accounts
    if new_balance < 1.0 and txn_type not in ("DEBIT", "WITHDRAWAL", "FEE", "TRANSFER_OUT"):
        return None
    if new_balance < 0 and acct_type in ("CHECKING", "SAVINGS", "MONEY_MARKET"):
        new_balance = round(balance * 0.05, 2)  # partial
        amount = round(new_balance - balance, 2)
        if amount == 0:
            return None

    return {
        "account_id": account_id,
        "txn_type": txn_type,
        "amount": amount,
        "description": description[:200],
        "merchant": merchant[:100],
        "balance_after": new_balance,
    }


def generate_batch(conn: pyodbc.Connection, count: int):
    """Insert `count` transactions and update account balances."""
    account_ids = list(_accounts.keys())
    if not account_ids:
        return

    cursor = conn.cursor()
    now = datetime.now(timezone.utc).replace(tzinfo=None)  # naive UTC (avoids pyodbc tz conversion)

    inserted = 0
    retries = 0
    while inserted < count and retries < count * 3:
        account_id = random.choice(account_ids)
        acct = _accounts[account_id]
        txn = _generate_transaction(account_id, acct)
        if txn is None:
            retries += 1
            continue

        new_balance = txn["balance_after"]
        try:
            cursor.execute(
                """INSERT INTO dbo.transactions
                   (account_id, txn_type, amount, description, merchant,
                    balance_after, txn_ts, source_write_ts)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                txn["account_id"], txn["txn_type"], txn["amount"],
                txn["description"], txn["merchant"], new_balance,
                now, now,
            )
            cursor.execute(
                """UPDATE dbo.accounts
                   SET balance = ?, updated_at = ?
                   WHERE account_id = ?""",
                new_balance, now, account_id,
            )
            # Update in-memory state
            _accounts[account_id]["balance"] = new_balance
            inserted += 1
        except Exception as exc:
            _stats["errors"] += 1
            print(f"  [generator] Insert error: {exc}", file=sys.stderr)
            retries += 1
            continue

    try:
        conn.commit()
        _stats["total_transactions"] += inserted
        _stats["total_account_updates"] += inserted
    except Exception as exc:
        print(f"  [generator] Commit error: {exc}", file=sys.stderr)
        conn.rollback()


def _update_random_customer(conn: pyodbc.Connection):
    """Simulate a Jack Henry address/profile update."""
    if not _accounts:
        return
    acct = random.choice(list(_accounts.values()))
    cust_id = acct["customer_id"]
    now = datetime.now(timezone.utc).replace(tzinfo=None)  # naive UTC (avoids pyodbc tz conversion)
    cursor = conn.cursor()
    cursor.execute(
        """UPDATE dbo.customers
           SET street = ?, city = ?, state = ?, zip = ?, updated_at = ?
           WHERE customer_id = ?""",
        fake.street_address()[:100],
        fake.city()[:50],
        fake.state_abbr(),
        fake.zipcode()[:10],
        now,
        cust_id,
    )
    conn.commit()
    _stats["total_customer_updates"] += 1


def _generate_member_update(conn: pyodbc.Connection):
    """Simulate an external system (card processor) sending a member profile update.

    This writes to dbo.member_updates keyed by ssn_last4 + last_name (NOT customer_id),
    demonstrating the match-and-merge pattern that replaces a Dynamic Table.
    """
    if not _accounts:
        return
    # Pick a random existing customer to generate an update for
    acct = random.choice(list(_accounts.values()))
    cust_id = acct["customer_id"]
    now = datetime.now(timezone.utc).replace(tzinfo=None)

    cursor = conn.cursor()
    # Look up the customer's ssn_last4 and last_name (the match keys)
    cursor.execute(
        "SELECT ssn_last4, last_name, first_name, email, phone FROM dbo.customers WHERE customer_id = ?",
        cust_id,
    )
    row = cursor.fetchone()
    if not row:
        return

    ssn_last4 = row.ssn_last4.strip() if row.ssn_last4 else str(random.randint(1000, 9999))
    last_name = row.last_name

    # Randomly change some fields to simulate an external update
    update_type = random.choice(["address", "phone", "email", "address"])
    new_email = None
    new_phone = None
    new_street = None
    new_city = None
    new_state = None
    new_zip = None

    if update_type == "address":
        new_street = fake.street_address()[:100]
        new_city = fake.city()[:50]
        new_state = fake.state_abbr()
        new_zip = fake.zipcode()[:10]
    elif update_type == "phone":
        new_phone = fake.phone_number()[:20]
    elif update_type == "email":
        new_email = fake.email()

    cursor.execute(
        """INSERT INTO dbo.member_updates
           (ssn_last4, last_name, first_name, email, phone,
            street, city, state, zip, operation, source_ts, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'upsert', ?, ?)""",
        ssn_last4,
        last_name,
        row.first_name,
        new_email,
        new_phone,
        new_street,
        new_city,
        new_state,
        new_zip,
        now,
        now,
    )
    conn.commit()
    _stats["total_customer_updates"] += 1


# ── FastAPI control server ─────────────────────────────────────
app = FastAPI(title="FUB Data Generator")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/status")
def status():
    elapsed = time.time() - _stats["start_time"] if _stats["start_time"] else 0
    tps_actual = (
        _stats["total_transactions"] / elapsed if elapsed > 0 else 0
    )
    return {
        "running": _running,
        "tps_target": _current_tps,
        "tps_actual": round(tps_actual, 1),
        "total_transactions": _stats["total_transactions"],
        "total_account_updates": _stats["total_account_updates"],
        "total_customer_updates": _stats["total_customer_updates"],
        "errors": _stats["errors"],
        "accounts_loaded": len(_accounts),
    }


@app.post("/start")
def start(tps: int = 10):
    global _running, _current_tps
    _current_tps = max(1, min(tps, 1000))
    _running = True
    if _stats["start_time"] is None:
        _stats["start_time"] = time.time()
    return {"status": "started", "tps": _current_tps}


@app.post("/stop")
def stop():
    global _running
    _running = False
    return {"status": "stopped"}


@app.post("/tps")
def set_tps(tps: int):
    global _current_tps
    _current_tps = max(1, min(tps, 1000))
    return {"tps": _current_tps}


# ── Main generation loop ───────────────────────────────────────
def run_generator(start_running: bool = True):
    global _running, _stats

    print("Connecting to SQL Server...")
    conn = get_connection()
    print(f"  Connected: {Config.SQLSERVER_HOST}:{Config.SQLSERVER_PORT}/{Config.SQLSERVER_DATABASE}")

    print("Checking/seeding database...")
    seed_database(conn)
    _load_accounts_into_memory(conn)
    print(f"  {len(_accounts)} accounts loaded into memory.")

    if start_running:
        _running = True
        _stats["start_time"] = time.time()
        print(f"Starting generation at {_current_tps} TPS. POST /stop to pause.")

    update_counter = 0
    member_update_counter = 0

    while True:
        if _running:
            tick_start = time.time()
            try:
                generate_batch(conn, _current_tps)
                # Every ~100 txns trigger a customer profile update (CDC demo)
                update_counter += _current_tps
                if update_counter >= 100:
                    _update_random_customer(conn)
                    update_counter = 0
                # Every ~50 txns trigger a member update (match-and-merge demo)
                member_update_counter += _current_tps
                if member_update_counter >= 50:
                    _generate_member_update(conn)
                    member_update_counter = 0
            except Exception as exc:
                _stats["errors"] += 1
                print(f"[generator] Loop error: {exc}", file=sys.stderr)
                try:
                    conn = get_connection()
                except Exception:
                    pass

            elapsed = time.time() - tick_start
            sleep_time = max(0.0, 1.0 - elapsed)
            time.sleep(sleep_time)
        else:
            time.sleep(0.2)


def main():
    parser = argparse.ArgumentParser(description="FUB Data Generator")
    parser.add_argument("--tps", type=int, default=Config.DEFAULT_TPS,
                        help="Transactions per second (default: %(default)s)")
    parser.add_argument("--seed-only", action="store_true",
                        help="Seed the database and exit without generating live data")
    parser.add_argument("--no-api", action="store_true",
                        help="Disable the HTTP control API")
    parser.add_argument("--standby", action="store_true",
                        help="Start API server but wait for POST /start before generating")
    args = parser.parse_args()

    global _current_tps
    _current_tps = args.tps

    if args.seed_only:
        conn = get_connection()
        seed_database(conn)
        _load_accounts_into_memory(conn)
        print(f"Seed complete. {len(_accounts)} accounts ready.")
        return

    if not args.no_api:
        api_thread = threading.Thread(
            target=lambda: uvicorn.run(
                app,
                host="0.0.0.0",
                port=Config.GENERATOR_PORT,
                log_level="warning",
            ),
            daemon=True,
        )
        api_thread.start()
        print(f"Generator control API: http://localhost:{Config.GENERATOR_PORT}")

    if args.standby:
        print(f"STANDBY MODE: waiting for POST /start (TPS will be {_current_tps})")
        print(f"  Hit the 'Start Demo' button in the app, or: curl -X POST localhost:{Config.GENERATOR_PORT}/start?tps={_current_tps}")
        run_generator(start_running=False)
    else:
        run_generator(start_running=True)


if __name__ == "__main__":
    main()
