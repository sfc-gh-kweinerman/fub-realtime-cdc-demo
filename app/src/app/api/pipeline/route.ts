import { NextResponse } from "next/server";
import { query } from "@/lib/snowflake";

export const dynamic = "force-dynamic";

interface SourceRow {
  txn_id: number;
  account_id: number;
  txn_type: string;
  amount: number;
  merchant: string;
  balance_after: number;
  txn_ts: string;
  source_write_ts: string;
}

interface SnowflakeRow {
  TXN_ID: number;
  ACCOUNT_ID: number;
  TXN_TYPE: string;
  AMOUNT: number;
  MERCHANT: string;
  BALANCE_AFTER: number;
  SOURCE_WRITE_TS: string;
  SNOWFLAKE_INGEST_TS: string;
  SLA_MS: number;
}

export async function GET() {
  const pollerUrl = process.env.POLLER_URL || "http://localhost:8080";

  // Fetch recent transactions from SQL Server (via poller)
  let sourceRows: SourceRow[] = [];
  try {
    const res = await fetch(`${pollerUrl}/recent`, { next: { revalidate: 0 } });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) sourceRows = data;
    }
  } catch { /* poller not running */ }

  // Fetch the same txn_ids from Snowflake
  let sfRows: SnowflakeRow[] = [];
  if (sourceRows.length > 0) {
    const ids = sourceRows.map((r) => r.txn_id).filter(Boolean);
    if (ids.length > 0) {
      try {
        sfRows = await query<SnowflakeRow>(`
          SELECT txn_id, account_id, txn_type, amount, merchant, balance_after,
                 source_write_ts, snowflake_ingest_ts,
                 DATEDIFF('millisecond', source_write_ts, snowflake_ingest_ts) AS sla_ms
          FROM transactions_landing
          WHERE txn_id IN (${ids.join(",")})
        `);
      } catch { /* table might be empty */ }
    }
  }

  // Also get current account balances from hybrid table for matched accounts
  let accountBalances: Record<number, number> = {};
  if (sourceRows.length > 0) {
    const acctIds = [...new Set(sourceRows.map((r) => r.account_id))];
    try {
      const balances = await query<{ ACCOUNT_ID: number; BALANCE: number }>(`
        SELECT account_id, balance
        FROM accounts_ht
        WHERE account_id IN (${acctIds.join(",")})
      `);
      accountBalances = Object.fromEntries(balances.map((b) => [b.ACCOUNT_ID, b.BALANCE]));
    } catch { /* ignore */ }
  }

  // Match source rows with Snowflake rows
  const sfMap = new Map(sfRows.map((r) => [r.TXN_ID, r]));

  const matched = sourceRows.map((src) => {
    const sf = sfMap.get(src.txn_id);
    return {
      txn_id: src.txn_id,
      account_id: src.account_id,
      txn_type: src.txn_type,
      amount: src.amount,
      merchant: src.merchant,
      source_write_ts: src.source_write_ts,
      // Source side
      source_balance_after: src.balance_after,
      // Snowflake side (null if not yet arrived)
      arrived: !!sf,
      snowflake_ingest_ts: sf?.SNOWFLAKE_INGEST_TS || null,
      sla_ms: sf?.SLA_MS || null,
      // Hybrid table balance
      ht_balance: accountBalances[src.account_id] ?? null,
    };
  });

  return NextResponse.json({
    rows: matched,
    source_count: sourceRows.length,
    arrived_count: matched.filter((r) => r.arrived).length,
    pending_count: matched.filter((r) => !r.arrived).length,
  });
}
