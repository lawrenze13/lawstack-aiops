import { EventEmitter } from "node:events";

// In-process pub/sub for run events. One EventEmitter per runId so SSE
// subscribers only receive events for the run they care about.
//
// HMR-safe singleton: dev hot-reload would otherwise create a new map per
// reload and orphan listeners. The cap on listenerCount prevents the
// "MaxListenersExceededWarning" when many tabs subscribe to the same run.

declare global {
  // eslint-disable-next-line no-var
  var __runBuses: Map<string, EventEmitter> | undefined;
}

const buses: Map<string, EventEmitter> = globalThis.__runBuses ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalThis.__runBuses = buses;
}

export type RunEvent = {
  /** monotonic per run; matches messages.seq for SSE Last-Event-ID replay */
  seq: number;
  /** event type that drives client-side rendering */
  type: "system" | "assistant" | "user" | "stream_event" | "result" | "server";
  payload: unknown;
};

export type RunEndEvent = {
  type: "end";
  status: "completed" | "failed" | "stopped" | "cost_killed" | "interrupted";
  reason?: string;
};

export function getRunBus(runId: string): EventEmitter {
  let bus = buses.get(runId);
  if (!bus) {
    bus = new EventEmitter();
    bus.setMaxListeners(50); // generous; small team x few tabs each
    buses.set(runId, bus);
  }
  return bus;
}

/**
 * Drop the bus for a run (call after the child exits and any final replay
 * window passes). Subsequent subscribers will get a fresh empty bus and
 * fall back to DB replay only.
 */
export function closeRunBus(runId: string): void {
  const bus = buses.get(runId);
  if (!bus) return;
  bus.removeAllListeners();
  buses.delete(runId);
}
