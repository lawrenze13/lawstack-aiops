import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness probe. Unauthenticated, no DB — just confirms the Next.js
 * server is accepting requests. Used by scripts/smoke-install.sh and
 * suitable for any external process manager (PM2, systemd, k8s).
 */
export function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() });
}
