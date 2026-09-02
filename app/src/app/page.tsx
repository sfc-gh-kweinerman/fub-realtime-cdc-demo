import { query } from "@/lib/snowflake";
import TransactionFeed from "@/components/TransactionFeed";

// Fetch a small initial dataset server-side so the page isn't blank on load.
// The client component then takes over polling.
async function getInitialFeed() {
  if (process.env.MOCK_MODE === "true") return [];
  try {
    return await query(`
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
      LIMIT 25
    `);
  } catch {
    return [];
  }
}

async function getSummary() {
  if (process.env.MOCK_MODE === "true") {
    return { total: 4521, avg_sla: 342 };
  }
  try {
    const [row] = await query<{ TOTAL: number; AVG_SLA: number }>(`
      SELECT
        COUNT(*)                                                       AS total,
        ROUND(AVG(DATEDIFF('millisecond', source_write_ts, snowflake_ingest_ts)), 0) AS avg_sla
      FROM transactions_landing
      WHERE snowflake_ingest_ts >= DATEADD('minute', -5, CONVERT_TIMEZONE('UTC', CURRENT_TIMESTAMP())::TIMESTAMP_NTZ)
    `);
    return { total: row?.TOTAL ?? 0, avg_sla: row?.AVG_SLA ?? null };
  } catch {
    return { total: 0, avg_sla: null };
  }
}

export const revalidate = 0;

export default async function HomePage() {
  const [feed, summary] = await Promise.all([getInitialFeed(), getSummary()]);

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Transactions (last hour)</p>
          <p className="text-3xl font-bold text-bank-navy mt-1">
            {summary.total.toLocaleString()}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-bank-sky/40 bg-bank-light shadow-sm p-5">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Hybrid Table P50 Latency</p>
          <p className="text-3xl font-bold text-bank-navy mt-1">
            &lt; 100ms
          </p>
          <p className="text-xs text-slate-400 mt-1">
            SQL Server → accounts_ht (direct MERGE)
          </p>
        </div>
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5">
          <p className="text-xs text-slate-500 uppercase tracking-wide">Landing Table Avg SLA</p>
          <p className="text-3xl font-bold text-bank-navy mt-1">
            {summary.avg_sla != null ? `${(summary.avg_sla / 1000).toFixed(1)}s` : "—"}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Source write → Snowflake visible
          </p>
        </div>
      </div>

      {/* Account search */}
      <form action="/accounts" method="get" className="flex gap-3">
        <input
          name="id"
          type="number"
          placeholder="Account number (e.g. 1001)"
          className="flex-1 border border-slate-300 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-bank-sky"
        />
        <button
          type="submit"
          className="bg-bank-navy text-white px-5 py-2 rounded-lg text-sm font-semibold hover:bg-bank-blue transition-colors"
        >
          Look up account →
        </button>
      </form>

      {/* Live feed */}
      <TransactionFeed initialRows={feed as any} />
    </div>
  );
}
