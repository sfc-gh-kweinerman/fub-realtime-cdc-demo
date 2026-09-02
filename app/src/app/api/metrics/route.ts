import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// --- Mock metrics (MOCK_MODE=true) ----------------------------
function mockMetrics() {
  const p50 = Math.floor(Math.random() * 40 + 30);
  return {
    poller_running: true,
    snowpipe_streaming_enabled: false,
    hybrid_write_p50_ms: p50,
    hybrid_write_p95_ms: p50 + Math.floor(Math.random() * 60 + 20),
    hybrid_write_p99_ms: p50 + Math.floor(Math.random() * 120 + 60),
    txn_ingest_p50_ms: 4200 + Math.floor(Math.random() * 800),
    txn_ingest_p95_ms: 7100 + Math.floor(Math.random() * 1200),
    rows_last_60s: Math.floor(Math.random() * 300 + 400),
    rows_last_5s: Math.floor(Math.random() * 30 + 40),
    tps_last_5s: +(Math.random() * 8 + 8).toFixed(1),
    total_txns_ingested: 4500 + Math.floor(Math.random() * 500),
    total_acct_updates: 4300 + Math.floor(Math.random() * 400),
    total_cust_updates: 43 + Math.floor(Math.random() * 10),
    errors: 0,
    uptime_s: 420,
    poll_interval_ms: 500,
    mock: true,
  };
}

// --- Generator mock status ------------------------------------
function mockGeneratorStatus() {
  return {
    running: true,
    tps_target: 10,
    tps_actual: +(Math.random() * 2 + 9).toFixed(1),
    total_transactions: 4500,
    accounts_loaded: 150,
    mock: true,
  };
}

// --- Route -----------------------------------------------------
export async function GET() {
  if (process.env.MOCK_MODE === "true") {
    return NextResponse.json({
      poller: mockMetrics(),
      generator: mockGeneratorStatus(),
    });
  }

  const pollerUrl    = process.env.POLLER_URL    || "http://localhost:8080";
  const generatorUrl = process.env.GENERATOR_URL || "http://localhost:8081";

  const [pollerRes, genRes] = await Promise.allSettled([
    fetch(`${pollerUrl}/metrics`,    { next: { revalidate: 0 } }),
    fetch(`${generatorUrl}/status`,  { next: { revalidate: 0 } }),
  ]);

  const pollerData =
    pollerRes.status === "fulfilled" && pollerRes.value.ok
      ? await pollerRes.value.json()
      : { error: "Poller not running", poller_running: false };

  const genData =
    genRes.status === "fulfilled" && genRes.value.ok
      ? await genRes.value.json()
      : { error: "Generator not running", running: false };

  return NextResponse.json({ poller: pollerData, generator: genData });
}

export async function POST(req: Request) {
  const { action, tps } = await req.json() as { action: string; tps?: number };
  const generatorUrl = process.env.GENERATOR_URL || "http://localhost:8081";

  if (process.env.MOCK_MODE === "true") {
    return NextResponse.json({ ok: true, mock: true });
  }

  try {
    let endpoint = "";
    let body: Record<string, unknown> = {};

    if (action === "start") {
      endpoint = "/start";
      body = { tps: tps ?? 10 };
    } else if (action === "stop") {
      endpoint = "/stop";
    } else if (action === "tps" && tps !== undefined) {
      endpoint = "/tps";
      body = { tps };
    } else {
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }

    const url = new URL(endpoint, generatorUrl);
    if (action === "tps" || action === "start") {
      url.searchParams.set("tps", String(tps ?? 10));
    }

    const res = await fetch(url.toString(), { method: "POST" });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}
