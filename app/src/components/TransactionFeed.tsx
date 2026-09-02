"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { LatencyBadge } from "./LatencyBadge";

interface TxnRow {
  TXN_ID: number;
  ACCOUNT_ID: number | string;
  TXN_TYPE: string;
  AMOUNT: number;
  MERCHANT: string;
  TXN_TS: string;
  SLA_MS: number | null;
  _isNew?: boolean;
}

const TXN_COLORS: Record<string, string> = {
  DEPOSIT:      "bg-emerald-100 text-emerald-700",
  TRANSFER_IN:  "bg-emerald-100 text-emerald-700",
  DEBIT:        "bg-rose-100    text-rose-700",
  WITHDRAWAL:   "bg-rose-100    text-rose-700",
  TRANSFER_OUT: "bg-orange-100  text-orange-700",
  FEE:          "bg-slate-100   text-slate-600",
  INTEREST:     "bg-blue-100    text-blue-700",
};

function timeAgo(iso: string): string {
  const diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (diff < 60)  return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function formatAmount(amount: number): string {
  const abs = Math.abs(amount).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
  return amount >= 0 ? `+${abs}` : abs;
}

interface Props {
  initialRows?: TxnRow[];
}

export default function TransactionFeed({ initialRows }: Props) {
  const [rows, setRows]           = useState<TxnRow[]>(initialRows ?? []);
  const [loading, setLoading]     = useState(!initialRows?.length);
  const [lastRefresh, setLastRefresh] = useState(Date.now());
  const [error, setError]         = useState<string | null>(null);
  const seenIds                   = useRef(new Set<number>());
  const [now, setNow]             = useState(Date.now());

  // Keep "X ago" labels fresh
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const fetchFeed = async () => {
    try {
      const res = await fetch("/api/feed", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: TxnRow[] = await res.json();

      setRows((prev) => {
        const prevMap = new Map(prev.map((r) => [r.TXN_ID, r]));
        const newRows = data
          .filter((r) => !seenIds.current.has(r.TXN_ID))
          .map((r) => ({ ...r, _isNew: true }));
        newRows.forEach((r) => seenIds.current.add(r.TXN_ID));

        // After animation window, clear _isNew flag
        if (newRows.length > 0) {
          setTimeout(() => {
            setRows((cur) => cur.map((r) => ({ ...r, _isNew: false })));
          }, 500);
        }

        const merged = [
          ...newRows,
          ...prev.filter((r) => !newRows.find((n) => n.TXN_ID === r.TXN_ID)),
        ].slice(0, 50);
        return merged;
      });

      setLastRefresh(Date.now());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Fetch failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFeed();
    const id = setInterval(fetchFeed, 2000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Table header */}
      <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold text-slate-800">Live Transaction Feed</h2>
          <span className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse-dot inline-block" />
            LIVE
          </span>
        </div>
        <div className="text-xs text-slate-400">
          {loading ? "Loading…" : error ? (
            <span className="text-red-500">{error}</span>
          ) : (
            `Refreshed ${Math.round((Date.now() - lastRefresh) / 1000)}s ago`
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
              <th className="px-5 py-3 text-left font-medium">Account</th>
              <th className="px-5 py-3 text-left font-medium">Type</th>
              <th className="px-5 py-3 text-right font-medium">Amount</th>
              <th className="px-5 py-3 text-left font-medium">Merchant</th>
              <th className="px-5 py-3 text-left font-medium">Time</th>
              <th className="px-5 py-3 text-left font-medium">
                <span title="Time from SQL Server write to visible in Snowflake">
                  SLA ↗
                </span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-5 py-10 text-center text-slate-400">
                  No transactions yet. Start the data generator to see live data.
                </td>
              </tr>
            )}
            {rows.map((row) => (
              <tr
                key={row.TXN_ID}
                className={clsx(
                  "hover:bg-slate-50 transition-colors",
                  row._isNew && "animate-slide-in bg-emerald-50/40"
                )}
              >
                <td className="px-5 py-3 font-mono text-slate-600 text-xs">
                  <a
                    href={`/accounts/${row.ACCOUNT_ID}`}
                    className="hover:text-bank-sky hover:underline"
                  >
                    ACC-{String(row.ACCOUNT_ID).padStart(4, "0")}
                  </a>
                </td>
                <td className="px-5 py-3">
                  <span
                    className={clsx(
                      "px-2 py-0.5 rounded text-xs font-semibold",
                      TXN_COLORS[row.TXN_TYPE] ?? "bg-slate-100 text-slate-600"
                    )}
                  >
                    {row.TXN_TYPE}
                  </span>
                </td>
                <td
                  className={clsx(
                    "px-5 py-3 text-right font-semibold",
                    row.AMOUNT >= 0 ? "text-emerald-600" : "text-rose-600"
                  )}
                >
                  {formatAmount(row.AMOUNT)}
                </td>
                <td className="px-5 py-3 text-slate-600 max-w-[180px] truncate">
                  {row.MERCHANT}
                </td>
                <td className="px-5 py-3 text-slate-400 text-xs whitespace-nowrap">
                  {timeAgo(row.TXN_TS)}
                </td>
                <td className="px-5 py-3">
                  <LatencyBadge ms={row.SLA_MS} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
