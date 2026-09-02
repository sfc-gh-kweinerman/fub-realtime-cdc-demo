"use client";

import { useEffect, useState, useCallback } from "react";
import clsx from "clsx";

interface PipelineRow {
  txn_id: number;
  account_id: number;
  txn_type: string;
  amount: number;
  merchant: string;
  source_write_ts: string;
  source_balance_after: number;
  arrived: boolean;
  snowflake_ingest_ts: string | null;
  sla_ms: number | null;
  ht_balance: number | null;
}

interface PipelineData {
  rows: PipelineRow[];
  source_count: number;
  arrived_count: number;
  pending_count: number;
}

const TXN_COLORS: Record<string, { bg: string; text: string }> = {
  DEBIT:        { bg: "bg-rose-100", text: "text-rose-700" },
  DEPOSIT:      { bg: "bg-emerald-100", text: "text-emerald-700" },
  WITHDRAWAL:   { bg: "bg-rose-100", text: "text-rose-700" },
  TRANSFER_IN:  { bg: "bg-emerald-100", text: "text-emerald-700" },
  TRANSFER_OUT: { bg: "bg-orange-100", text: "text-orange-700" },
  FEE:          { bg: "bg-slate-100", text: "text-slate-600" },
  INTEREST:     { bg: "bg-blue-100", text: "text-blue-700" },
};

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 } as any);
}

function formatAmount(amount: number): string {
  const abs = Math.abs(amount).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return amount >= 0 ? `+${abs}` : `-${abs}`;
}

function SLABadge({ ms }: { ms: number | null }) {
  if (ms === null) return <span className="text-slate-300 text-xs italic">pending...</span>;
  const label = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  return (
    <span className={clsx(
      "inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold",
      ms < 1000 && "bg-emerald-500 text-white",
      ms >= 1000 && ms < 3000 && "bg-yellow-500 text-white",
      ms >= 3000 && ms < 6000 && "bg-orange-500 text-white",
      ms >= 6000 && "bg-red-500 text-white",
    )}>
      {label}
    </span>
  );
}

export default function PipelineMonitor() {
  const [data, setData] = useState<PipelineData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/pipeline", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, 2000);
    return () => clearInterval(id);
  }, [fetchData]);

  if (loading) {
    return <div className="text-center py-20 text-slate-400">Loading pipeline data...</div>;
  }

  if (error) {
    return (
      <div className="text-center py-20">
        <p className="text-red-500 font-medium">{error}</p>
        <p className="text-sm text-slate-400 mt-2">Make sure the CDC poller and generator are running.</p>
      </div>
    );
  }

  if (!data || data.rows.length === 0) {
    return (
      <div className="text-center py-20 text-slate-400">
        No pipeline data yet. Start the generator and poller.
      </div>
    );
  }

  const arrivedPct = Math.round((data.arrived_count / data.source_count) * 100);

  return (
    <div className="space-y-5">
      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-white rounded-xl border border-slate-200 p-4 text-center shadow-sm">
          <div className="text-2xl font-bold text-bank-navy">{data.source_count}</div>
          <div className="text-xs text-slate-500 mt-1">In SQL Server</div>
        </div>
        <div className="bg-white rounded-xl border border-emerald-200 p-4 text-center shadow-sm">
          <div className="text-2xl font-bold text-emerald-600">{data.arrived_count}</div>
          <div className="text-xs text-slate-500 mt-1">Arrived in Snowflake</div>
        </div>
        <div className="bg-white rounded-xl border border-yellow-200 p-4 text-center shadow-sm">
          <div className="text-2xl font-bold text-yellow-600">{data.pending_count}</div>
          <div className="text-xs text-slate-500 mt-1">In Transit</div>
        </div>
        <div className="bg-white rounded-xl border border-bank-sky/30 bg-bank-light p-4 text-center shadow-sm">
          <div className="text-2xl font-bold text-bank-navy">{arrivedPct}%</div>
          <div className="text-xs text-slate-500 mt-1">Delivery Rate</div>
        </div>
      </div>

      {/* Live indicator */}
      <div className="flex items-center justify-center gap-2 text-sm text-emerald-600">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-dot inline-block" />
        <span className="font-medium">LIVE - Refreshing every 2 seconds</span>
      </div>

      {/* Split-screen pipeline */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        {/* Header */}
        <div className="grid grid-cols-[1fr_100px_1fr] border-b border-slate-200">
          <div className="px-5 py-3 bg-amber-50 border-r border-slate-200">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-amber-500" />
              <span className="font-semibold text-sm text-amber-800">SQL Server (Jack Henry)</span>
            </div>
            <div className="text-xs text-amber-600 mt-0.5">Source of truth - core banking</div>
          </div>
          <div className="px-2 py-3 bg-slate-50 flex items-center justify-center">
            <span className="text-xs font-bold text-slate-500 uppercase tracking-wide">SLA</span>
          </div>
          <div className="px-5 py-3 bg-emerald-50 border-l border-slate-200">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded bg-emerald-500" />
              <span className="font-semibold text-sm text-emerald-800">Snowflake Hybrid Table</span>
            </div>
            <div className="text-xs text-emerald-600 mt-0.5">accounts_ht - live balance serving</div>
          </div>
        </div>

        {/* Rows */}
        <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
          {data.rows.map((row, i) => {
            const colors = TXN_COLORS[row.txn_type] || { bg: "bg-slate-100", text: "text-slate-600" };
            return (
              <div
                key={row.txn_id}
                className={clsx(
                  "grid grid-cols-[1fr_100px_1fr] transition-colors",
                  i === 0 && "animate-slide-in",
                  !row.arrived && "bg-yellow-50/30"
                )}
              >
                {/* Left: SQL Server */}
                <div className="px-4 py-3 border-r border-slate-100">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={clsx("px-1.5 py-0.5 rounded text-[10px] font-bold", colors.bg, colors.text)}>
                        {row.txn_type}
                      </span>
                      <span className="text-xs font-mono text-slate-500">ACC-{String(row.account_id).padStart(4, "0")}</span>
                    </div>
                    <span className={clsx("text-sm font-bold", row.amount >= 0 ? "text-emerald-600" : "text-rose-600")}>
                      {formatAmount(row.amount)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-slate-400 truncate max-w-[140px]">{row.merchant}</span>
                    <span className="text-[10px] font-mono text-slate-400">{formatTime(row.source_write_ts)}</span>
                  </div>
                </div>

                {/* Middle: SLA arrow */}
                <div className="flex items-center justify-center bg-slate-50/50 px-1">
                  {row.arrived ? (
                    <div className="flex flex-col items-center gap-0.5">
                      <SLABadge ms={row.sla_ms} />
                      <svg width="24" height="12" viewBox="0 0 24 12" className="text-emerald-400">
                        <path d="M0 6 L18 6 M14 2 L18 6 L14 10" fill="none" stroke="currentColor" strokeWidth="1.5" />
                      </svg>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="text-[10px] text-yellow-500 font-medium">in transit</span>
                      <svg width="24" height="12" viewBox="0 0 24 12" className="text-yellow-400 animate-pulse">
                        <path d="M0 6 L12 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2" />
                        <circle cx="16" cy="6" r="2" fill="currentColor" />
                      </svg>
                    </div>
                  )}
                </div>

                {/* Right: Snowflake */}
                <div className="px-4 py-3 border-l border-slate-100">
                  {row.arrived ? (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-emerald-600 font-semibold flex items-center gap-1">
                          <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                          </svg>
                          Confirmed in Snowflake
                        </span>
                        <span className="text-[10px] font-mono text-slate-400">{formatTime(row.snowflake_ingest_ts)}</span>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        {row.ht_balance !== null && (
                          <span className="text-xs text-slate-600">
                            HT Balance: <span className="font-semibold">${row.ht_balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}</span>
                          </span>
                        )}
                        <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-medium">
                          HYBRID TABLE
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-center h-full">
                      <div className="flex items-center gap-2 text-yellow-500">
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span className="text-xs font-medium">Waiting for arrival...</span>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer explanation */}
      <div className="bg-slate-800 text-slate-200 rounded-xl p-5 text-xs font-mono leading-relaxed">
        <span className="text-slate-400">How this works:</span>{" "}
        Left panel queries SQL Server directly (via poller /recent endpoint).
        Right panel queries Snowflake transactions_landing + accounts_ht.
        Records are matched by txn_id. The SLA badge shows{" "}
        <span className="text-emerald-400">source_write_ts → snowflake_ingest_ts</span>{" "}
        difference. Green = sub-second. The hybrid table balance is the LIVE value from a PK lookup.
      </div>
    </div>
  );
}
