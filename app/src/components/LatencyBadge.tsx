"use client";

import clsx from "clsx";

interface Props {
  ms: number | null | undefined;
  /** If true shows "—" for null and uses softer text */
  quiet?: boolean;
}

export function LatencyBadge({ ms, quiet }: Props) {
  if (ms === null || ms === undefined) {
    return <span className="text-slate-400 text-xs">—</span>;
  }

  const label =
    ms < 1000
      ? `${ms}ms`
      : ms < 10_000
      ? `${(ms / 1000).toFixed(1)}s`
      : `${(ms / 1000).toFixed(0)}s`;

  const color = clsx(
    "inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold",
    {
      "bg-emerald-100 text-emerald-700":  ms < 1000,
      "bg-yellow-100  text-yellow-700":   ms >= 1000  && ms < 3000,
      "bg-orange-100  text-orange-700":   ms >= 3000  && ms < 6000,
      "bg-red-100     text-red-700":      ms >= 6000,
    }
  );

  return <span className={clsx(color, quiet && "opacity-70")}>{label}</span>;
}
