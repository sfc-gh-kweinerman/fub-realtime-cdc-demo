import { NextResponse } from "next/server";
import { query } from "@/lib/snowflake";

// --- Mock data helpers (MOCK_MODE=true) -----------------------
function mockFeed() {
  const types = ["DEBIT", "DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "FEE"] as const;
  const merchants = [
    "Starbucks Coffee", "Payroll Direct", "ATM Withdrawal", "Shell Gas Station",
    "Amazon.com", "McDonald's", "Walmart", "Internal Transfer", "CVS Pharmacy",
  ];
  const now = Date.now();
  return Array.from({ length: 25 }, (_, i) => {
    const txnType = types[Math.floor(Math.random() * types.length)];
    const isCredit = txnType === "DEPOSIT" || txnType === "TRANSFER_IN";
    const amount = isCredit
      ? +(Math.random() * 4000 + 100).toFixed(2)
      : -(Math.random() * 200 + 5).toFixed(2);
    const sla = Math.floor(Math.random() * 800 + 150);
    const tsOffset = i * 2000 + Math.random() * 1000;
    return {
      TXN_ID: 90000 + i,
      ACCOUNT_ID: 1000 + Math.floor(Math.random() * 150),
      TXN_TYPE: txnType,
      AMOUNT: +amount,
      MERCHANT: merchants[Math.floor(Math.random() * merchants.length)],
      TXN_TS: new Date(now - tsOffset).toISOString(),
      SOURCE_WRITE_TS: new Date(now - tsOffset - sla).toISOString(),
      SNOWFLAKE_INGEST_TS: new Date(now - tsOffset).toISOString(),
      SLA_MS: sla,
    };
  });
}

// --- Route -----------------------------------------------------
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.MOCK_MODE === "true") {
    return NextResponse.json(mockFeed());
  }

  try {
    const rows = await query(`
      SELECT
        txn_id,
        account_id,
        txn_type,
        amount,
        merchant,
        txn_ts,
        source_write_ts,
        snowflake_ingest_ts,
        DATEDIFF('millisecond', source_write_ts, snowflake_ingest_ts) AS sla_ms
      FROM transactions_landing
      ORDER BY snowflake_ingest_ts DESC
      LIMIT 50
    `);
    return NextResponse.json(rows);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
