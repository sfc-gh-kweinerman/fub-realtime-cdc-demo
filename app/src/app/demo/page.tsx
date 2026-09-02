import DemoControls from "@/components/DemoControls";

export default function DemoPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-bank-navy">Demo Controls</h1>
        <p className="text-sm text-slate-500 mt-1">
          Control the synthetic data generator and monitor the live pipeline.
          Not shown during customer-facing demos — keep this tab open on a separate screen.
        </p>
      </div>
      <DemoControls />
    </div>
  );
}
