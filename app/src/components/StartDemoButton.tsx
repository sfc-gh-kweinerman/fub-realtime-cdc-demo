"use client";

import { useState } from "react";
import clsx from "clsx";

type Phase = "idle" | "starting" | "warming" | "live";

export default function StartDemoButton({ onStarted }: { onStarted?: () => void }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [tps, setTps] = useState(5);

  const startDemo = async () => {
    setPhase("starting");

    try {
      // Call the generator's /start endpoint via our API proxy
      const res = await fetch("/api/metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", tps }),
      });

      if (!res.ok) throw new Error("Failed to start generator");

      setPhase("warming");

      // Wait for first data to appear in Snowflake (warehouse warm-up)
      let attempts = 0;
      const pollForData = async (): Promise<boolean> => {
        const r = await fetch("/api/feed", { cache: "no-store" });
        const data = await r.json();
        return Array.isArray(data) && data.length > 0;
      };

      while (attempts < 30) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts++;
        if (await pollForData()) {
          setPhase("live");
          onStarted?.();
          return;
        }
      }

      // Even if data hasn't arrived yet, switch to live after 60s
      setPhase("live");
      onStarted?.();
    } catch {
      setPhase("idle");
    }
  };

  if (phase === "live") {
    return null; // Hide once demo is running
  }

  if (phase === "warming") {
    return (
      <div className="bg-gradient-to-br from-bank-navy to-blue-900 rounded-2xl p-10 text-center text-white shadow-xl">
        <div className="inline-flex items-center gap-3 mb-4">
          <svg className="w-6 h-6 animate-spin text-bank-sky" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="text-lg font-semibold">Warming Up</span>
        </div>
        <p className="text-blue-200 text-sm max-w-md mx-auto">
          Transactions are being generated and flowing through the pipeline.
          Snowflake warehouse is warming up for the first queries...
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          {["SQL Server", "CDC Poller", "Snowflake"].map((step, i) => (
            <div key={step} className="flex items-center gap-2">
              <div className={clsx(
                "w-3 h-3 rounded-full",
                i < 2 ? "bg-emerald-400" : "bg-yellow-400 animate-pulse"
              )} />
              <span className="text-xs text-blue-200">{step}</span>
              {i < 2 && (
                <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (phase === "starting") {
    return (
      <div className="bg-gradient-to-br from-bank-navy to-blue-900 rounded-2xl p-10 text-center text-white shadow-xl">
        <svg className="w-8 h-8 animate-spin text-bank-sky mx-auto mb-3" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <p className="text-blue-200 text-sm">Starting data generator...</p>
      </div>
    );
  }

  // Idle state - show the big start button
  return (
    <div className="bg-gradient-to-br from-bank-navy to-blue-900 rounded-2xl p-10 text-center text-white shadow-xl">
      <h2 className="text-2xl font-bold mb-2">Ready to Demo</h2>
      <p className="text-blue-200 text-sm max-w-lg mx-auto mb-8">
        The CDC poller is running and watching SQL Server for changes.
        Click below to start generating live banking transactions and watch them
        flow into Snowflake hybrid tables in real-time.
      </p>

      {/* TPS selector */}
      <div className="flex items-center justify-center gap-3 mb-6">
        <span className="text-xs text-blue-300 uppercase tracking-wide">Speed:</span>
        {[3, 5, 10, 25].map((t) => (
          <button
            key={t}
            onClick={() => setTps(t)}
            className={clsx(
              "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
              tps === t
                ? "bg-white text-bank-navy shadow-lg scale-105"
                : "bg-white/10 text-blue-200 hover:bg-white/20"
            )}
          >
            {t} TPS
          </button>
        ))}
      </div>

      {/* Start button */}
      <button
        onClick={startDemo}
        className="group relative inline-flex items-center gap-3 px-10 py-4 bg-emerald-500 hover:bg-emerald-400 text-white font-bold text-lg rounded-xl shadow-lg hover:shadow-emerald-500/30 transition-all hover:scale-105 active:scale-95"
      >
        <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
          <path d="M8 5v14l11-7z" />
        </svg>
        Start Demo
      </button>

      <p className="text-xs text-blue-300 mt-4 opacity-70">
        First query may take 10-30s while the warehouse warms up
      </p>
    </div>
  );
}
