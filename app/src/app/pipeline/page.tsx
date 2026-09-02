"use client";

import { useState } from "react";
import StartDemoButton from "@/components/StartDemoButton";
import PipelineMonitor from "@/components/PipelineMonitor";

export default function PipelinePage() {
  const [demoStarted, setDemoStarted] = useState(false);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-bank-navy">Pipeline Monitor</h1>
        <p className="text-sm text-slate-500 mt-1">
          Watch data flow from SQL Server (Jack Henry) to Snowflake hybrid tables in real-time.
        </p>
      </div>

      {!demoStarted && (
        <StartDemoButton onStarted={() => setDemoStarted(true)} />
      )}

      <PipelineMonitor />
    </div>
  );
}
