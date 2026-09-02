"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";

interface Metrics {
  poller: {
    poller_running?: boolean;
    snowpipe_streaming_enabled?: boolean;
    hybrid_write_p50_ms?: number | null;
    hybrid_write_p95_ms?: number | null;
    txn_ingest_p50_ms?: number | null;
    txn_ingest_p95_ms?: number | null;
    rows_last_60s?: number;
    tps_last_5s?: number;
    total_txns_ingested?: number;
    errors?: number;
    error?: string;
    mock?: boolean;
  };
  generator: {
    running?: boolean;
    tps_target?: number;
    tps_actual?: number;
    total_transactions?: number;
    accounts_loaded?: number;
    error?: string;
    mock?: boolean;
  };
}

const TPS_PRESETS = [5, 10, 25, 50, 100, 250] as const;

export default function DemoControls() {
  const [metrics,    setMetrics]    = useState<Metrics | null>(null);
  const [tps,        setTps]        = useState(10);
  const [busy,       setBusy]       = useState(false);
  const [lastAction, setLastAction] = useState<string>("");

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch("/api/metrics", { cache: "no-store" });
      const data = await res.json();
      setMetrics(data);
      if (data.generator?.tps_target) setTps(data.generator.tps_target);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    fetchMetrics();
    const id = setInterval(fetchMetrics, 3000);
    return () => clearInterval(id);
  }, [fetchMetrics]);

  const controlGenerator = async (action: string, newTps?: number) => {
    setBusy(true);
    try {
      await fetch("/api/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, tps: newTps ?? tps }),
      });
      setLastAction(`${action} @ ${newTps ?? tps} TPS`);
      await fetchMetrics();
    } finally {
      setBusy(false);
    }
  };

  const gen   = metrics?.generator;
  const pol   = metrics?.poller;
  const alive = gen?.running && pol?.poller_running;

  return (
    <div className="space-y-6">
      {/* Status banner */}
      <div
        className={clsx(
          "rounded-xl border px-6 py-4 flex items-center justify-between",
          alive
            ? "bg-emerald-50 border-emerald-200"
            : "bg-slate-50 border-slate-200"
        )}
      >
        <div className="flex items-center gap-3">
          <span
            className={clsx(
              "w-3 h-3 rounded-full",
              alive ? "bg-emerald-500 animate-pulse-dot" : "bg-slate-300"
            )}
          />
          <span className="font-medium text-slate-800">
            {alive ? "Demo pipeline is running" : "Demo pipeline is stopped"}
          </span>
          {metrics?.generator?.mock && (
            <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded">
              MOCK MODE
            </span>
          )}
        </div>
        <div className="text-sm text-slate-500">
          {gen?.tps_actual != null && (
            <span>{gen.tps_actual} TPS actual</span>
          )}
        </div>
      </div>

      {/* Generator controls */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <h3 className="font-semibold text-slate-800 mb-5">Generator Controls</h3>

        {/* TPS presets */}
        <div className="mb-5">
          <label className="block text-xs text-slate-500 uppercase tracking-wide mb-2">
            Transactions Per Second
          </label>
          <div className="flex gap-2 flex-wrap">
            {TPS_PRESETS.map((preset) => (
              <button
                key={preset}
                onClick={() => setTps(preset)}
                className={clsx(
                  "px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors",
                  tps === preset
                    ? "bg-bank-navy text-white border-bank-navy"
                    : "bg-white text-slate-600 border-slate-300 hover:border-bank-navy"
                )}
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-3">
          <button
            onClick={() => controlGenerator("start", tps)}
            disabled={busy || gen?.running === true}
            className={clsx(
              "px-5 py-2 rounded-lg text-sm font-semibold transition-colors",
              gen?.running
                ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                : "bg-emerald-600 hover:bg-emerald-700 text-white"
            )}
          >
            ▶ Start ({tps} TPS)
          </button>
          <button
            onClick={() => controlGenerator("stop")}
            disabled={busy || gen?.running === false}
            className={clsx(
              "px-5 py-2 rounded-lg text-sm font-semibold transition-colors",
              !gen?.running
                ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                : "bg-rose-600 hover:bg-rose-700 text-white"
            )}
          >
            ■ Stop
          </button>
          <button
            onClick={() => controlGenerator("tps", tps)}
            disabled={busy}
            className="px-5 py-2 rounded-lg text-sm font-semibold bg-bank-sky hover:bg-bank-blue text-white transition-colors"
          >
            Update TPS
          </button>
        </div>
        {lastAction && (
          <p className="text-xs text-slate-400 mt-3">Last action: {lastAction}</p>
        )}
      </div>

      {/* Live metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          {
            label: "Hybrid Table P50",
            value: pol?.hybrid_write_p50_ms != null ? `${pol.hybrid_write_p50_ms}ms` : "—",
            sub: "SQL Server → accounts_ht",
            highlight: true,
          },
          {
            label: "Hybrid Table P95",
            value: pol?.hybrid_write_p95_ms != null ? `${pol.hybrid_write_p95_ms}ms` : "—",
            sub: "95th percentile write",
          },
          {
            label: "Landing Table P50",
            value: pol?.txn_ingest_p50_ms != null
              ? `${(pol.txn_ingest_p50_ms / 1000).toFixed(1)}s`
              : "—",
            sub: "Snowpipe Streaming SLA",
          },
          {
            label: "Rows / 60s",
            value: pol?.rows_last_60s?.toLocaleString() ?? "—",
            sub: "transactions ingested",
          },
        ].map(({ label, value, sub, highlight }) => (
          <div
            key={label}
            className={clsx(
              "bg-white rounded-xl border p-4 shadow-sm",
              highlight ? "border-bank-sky/50 bg-bank-light" : "border-slate-200"
            )}
          >
            <p className="text-xs text-slate-500 uppercase tracking-wide">{label}</p>
            <p className={clsx("text-2xl font-bold mt-1", highlight ? "text-bank-navy" : "text-slate-800")}>
              {value}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      {/* Pipeline status */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-6">
        <h3 className="font-semibold text-slate-800 mb-4">Pipeline Status</h3>
        <div className="space-y-3 text-sm">
          {[
            { label: "Generator", ok: gen?.running, detail: gen?.error ?? `${gen?.accounts_loaded ?? 0} accounts loaded` },
            { label: "CDC Poller", ok: pol?.poller_running, detail: pol?.error ?? `${pol?.errors ?? 0} errors` },
            { label: "Snowpipe Streaming", ok: pol?.snowpipe_streaming_enabled, detail: pol?.snowpipe_streaming_enabled ? "Enabled" : "Disabled (using direct INSERT)" },
            { label: "Hybrid Table writes", ok: (pol?.hybrid_write_p50_ms ?? 0) > 0, detail: pol?.total_txns_ingested != null ? `${pol.total_txns_ingested.toLocaleString()} total` : "Waiting for data" },
          ].map(({ label, ok, detail }) => (
            <div key={label} className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
              <div className="flex items-center gap-2">
                <span className={clsx("w-2 h-2 rounded-full", ok ? "bg-emerald-500" : "bg-slate-300")} />
                <span className="font-medium text-slate-700">{label}</span>
              </div>
              <span className="text-slate-400 text-xs">{detail}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Architecture note */}
      <div className="bg-slate-800 text-slate-100 rounded-xl p-6 text-sm font-mono">
        <p className="text-slate-400 text-xs uppercase tracking-wide mb-3">Demo Architecture</p>
        <pre className="text-xs leading-relaxed whitespace-pre-wrap">{`SQL Server (Docker)
  └── Python CDC Poller (500ms poll)
        ├── Path A → Snowpipe Streaming ────────────► transactions_landing  (~5s)
        │                                              Standard table, full history
        └── Path B → Direct MERGE (SQLAlchemy pool) ► accounts_ht            (~50ms)
                                                       Hybrid table, live balance

React App (Next.js)
  ├── /api/feed          → SELECT FROM transactions_landing  (live feed)
  ├── /api/accounts/[id] → JOIN accounts_ht + transactions_landing  (Unistore)
  └── /api/metrics       → proxy to Python poller :8080 / generator :8081`}</pre>
      </div>
    </div>
  );
}
