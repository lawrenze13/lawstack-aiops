import { and, asc, eq, gt } from "drizzle-orm";
import { auth } from "@/server/auth/config";
import { db } from "@/server/db/client";
import { messages as messagesTable, runs } from "@/server/db/schema";
import { getRunBus } from "@/server/worker/runBus";
import type { RunEvent, RunEndEvent } from "@/server/worker/runBus";

// Server-Sent Events stream for a single run. Replays missed events from
// the messages table on connect (using Last-Event-ID), then attaches a live
// listener on the run's EventEmitter.
//
// MUST: runtime=nodejs (Edge cannot read req.signal w/ EventEmitter cleanly,
// and we need the same process the spawnAgent runs in for the in-memory bus).
// MUST: dynamic=force-dynamic (otherwise Next statically optimises and
// streaming silently breaks).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 15_000;

export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  const user = session?.user as { id?: string } | undefined;
  if (!user?.id) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // /api/runs/[id]/stream — id is two before 'stream'
  const runId = segments[segments.length - 2];
  if (!runId) {
    return new Response(JSON.stringify({ error: "missing run id" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const lastEventId = Number(req.headers.get("last-event-id") ?? "0") || 0;

  const encoder = new TextEncoder();
  const bus = getRunBus(runId);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: Uint8Array): void => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          // Stream already closed (client went away mid-write).
          closed = true;
        }
      };

      const sendEvent = (
        ev: string,
        data: unknown,
        id?: number | string,
      ): void => {
        const lines: string[] = [];
        if (id !== undefined) lines.push(`id: ${id}`);
        lines.push(`event: ${ev}`);
        lines.push(`data: ${JSON.stringify(data)}`);
        lines.push("", "");
        safeEnqueue(encoder.encode(lines.join("\n")));
      };

      // 1. Replay any messages persisted after the client's last seen seq.
      try {
        const replay = db
          .select({
            id: messagesTable.id,
            seq: messagesTable.seq,
            type: messagesTable.type,
            payloadJson: messagesTable.payloadJson,
          })
          .from(messagesTable)
          .where(and(eq(messagesTable.runId, runId), gt(messagesTable.seq, lastEventId)))
          .orderBy(asc(messagesTable.seq))
          .all();
        for (const row of replay) {
          let payload: unknown;
          try {
            payload = JSON.parse(row.payloadJson);
          } catch {
            payload = { raw: row.payloadJson };
          }
          sendEvent(row.type, payload, row.seq);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[sse] replay failed", { runId, err });
      }

      // 2. If the run is already in a TERMINAL state (completed / failed /
      //    stopped / cost_killed / interrupted), send end + close. We
      //    intentionally do NOT treat `awaiting_input` as terminal here:
      //    a resume is pending and may spawn a new subprocess on this
      //    same runId. Emitting end here would close the client's ES
      //    and fragment the single-session UX across chat turns.
      const isTerminal =
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "stopped" ||
        run.status === "cost_killed" ||
        run.status === "interrupted";
      if (isTerminal) {
        sendEvent("end", { status: run.status, reason: run.killedReason ?? null });
        closed = true;
        try {
          controller.close();
        } catch {
          // ignore
        }
        return;
      }

      // 3. Attach to the bus for live events.
      const onEvent = (ev: RunEvent): void => {
        sendEvent(ev.type, ev.payload, ev.seq);
      };
      const onEnd = (ev: RunEndEvent): void => {
        sendEvent("end", { status: ev.status, reason: ev.reason ?? null });
        cleanup(true);
      };
      bus.on("event", onEvent);
      bus.on("end", onEnd);

      // 4. Keep-alive comments to defeat proxy idle timeouts.
      const ka = setInterval(() => {
        safeEnqueue(encoder.encode(`: ka\n\n`));
      }, KEEPALIVE_MS);

      const cleanup = (close: boolean): void => {
        if (closed && !close) return;
        bus.off("event", onEvent);
        bus.off("end", onEnd);
        clearInterval(ka);
        if (close) {
          closed = true;
          try {
            controller.close();
          } catch {
            // ignore
          }
        }
      };

      // 5. Cleanup on client disconnect.
      req.signal.addEventListener("abort", () => cleanup(true));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
