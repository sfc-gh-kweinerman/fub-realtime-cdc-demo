import { NextResponse } from "next/server";
import { query } from "@/lib/snowflake";

// --- Mock data (MOCK_MODE=true) --------------------------------
function mockAccount(id: string) {
  const names = ["Sarah Mitchell", "James Patterson", "Maria Rodriguez", "David Kim"];
  const name = names[Number(id) % names.length] ?? "John Smith";
  const [first, ...rest] = name.split(" ");
  const balance = 10000 + (Number(id) * 137) % 40000;
  const now = Date.now();
  const transactions = Array.from({ length: 15 }, (_, i) => {
    const types = ["DEBIT", "DEPOSIT", "WITHDRAWAL", "TRANSFER_IN", "FEE"];
    const txnType = types[(Number(id) + i) % types.length];
    const isCredit = txnType === "DEPOSIT" || txnType === "TRANSFER_IN";
    const amount = isCredit ? +(Math.random() * 3000 + 50).toFixed(2) : -(Math.random() * 150 + 10).toFixed(2);
    return {
      TXN_ID: 80000 + i,
      TXN_TYPE: txnType,
      AMOUNT: +amount,
      MERCHANT: ["Starbucks", "Payroll", "ATM", "Amazon", "McDonald's"][i % 5],
      TXN_TS: new Date(now - i * 180_000).toISOString(),
      SLA_MS: Math.floor(Math.random() * 800 + 200),
    };
  });
  return {
    account: {
      ACCOUNT_ID: id,
      ACCOUNT_TYPE: "CHECKING",
      BALANCE: balance.toFixed(2),
      STATUS: "ACTIVE",
      CUSTOMER_NAME: name,
      FIRST_NAME: first,
      LAST_NAME: rest.join(" "),
      EMAIL: `${first.toLowerCase()}@example.com`,
      HT_WRITE_MS: Math.floor(Math.random() * 80 + 25),
      UPDATED_AT: new Date(now - 800).toISOString(),
      SOURCE_UPDATED_AT: new Date(now - 1400).toISOString(),
    },
    transactions,
  };
}

// --- Route -----------------------------------------------------
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const accountId = params.id;

  if (process.env.MOCK_MODE === "true") {
    return NextResponse.json(mockAccount(accountId));
  }

  try {
    // ── Hybrid table point lookup (sub-100ms) ──────────────────
    const [acctRow] = await query(`
      SELECT
        a.account_id,
        a.account_type,
        a.balance,
        a.status,
        a.updated_at,
        a.source_updated_at,
        CONCAT(c.first_name, ' ', c.last_name) AS customer_name,
        c.first_name,
        c.last_name,
        c.email,
        c.phone,
        -- Hybrid table write latency: SQL Server → Snowflake
        DATEDIFF('millisecond', a.source_updated_at, a.updated_at) AS ht_write_ms
      FROM accounts_ht a
      JOIN customers_ht c ON a.customer_id = c.customer_id
      WHERE a.account_id = ?
    `, [accountId]);

    if (!acctRow) {
      return NextResponse.json({ error: "Account not found" }, { status: 404 });
    }

    // ── Unistore join: hybrid (live balance) + standard (full history) ──
    const transactions = await query(`
      SELECT
        txn_id,
        txn_type,
        amount,
        merchant,
        description,
        txn_ts,
        source_write_ts,
        snowflake_ingest_ts,
        DATEDIFF('millisecond', source_write_ts, snowflake_ingest_ts) AS sla_ms
      FROM transactions_landing
      WHERE account_id = ?
      ORDER BY txn_ts DESC
      LIMIT 20
    `, [accountId]);

    return NextResponse.json({ account: acctRow, transactions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
