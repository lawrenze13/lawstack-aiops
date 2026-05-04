"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button } from "@heroui/react/button";
import { TextArea } from "@heroui/react/textarea";
import { useToast } from "@/components/toast/ToastHost";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type Props = {
  runId: string;
  /** Disables Send while the parent run is still streaming. */
  canSend: boolean;
  /** Human reason shown in the placeholder when canSend=false. */
  blockedReason?: string;
  /**
   * Called with the NEW runId returned by /api/runs/:id/message after
   * a successful send. The parent rebinds RunLog (and this ChatBox's
   * own SSE) to the new runId immediately, instead of waiting for
   * router.refresh() to surface it via DB. See CardThread.tsx for the
   * holder pattern.
   */
  onRunIdChanged?: (newRunId: string) => void;
};

const MessageResponse = z.object({ runId: z.string().min(1) });

export function ChatBox({ runId, canSend, blockedReason, onRunIdChanged }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Local optimistic unlock. The server-rendered `canSend` flips to true
  // only after router.refresh() re-reads the DB — which takes a round-trip.
  // By subscribing to the run's SSE for `needs_input` / `end` events, we
  // unlock the input the instant those signals arrive, with no flash of
  // "still disabled" while the page refetches.
  const [localUnlock, setLocalUnlock] = useState(false);
  // Synchronous in-flight guard. `pending` (from useTransition) clears on
  // the next render, but a user mashing Cmd+Enter can fire `send` twice
  // in the same tick before `pending` flips. Without this ref, the
  // second `send` would POST to the OLD runId — server creates a sibling
  // resume run on the wrong target.
  const inFlightRef = useRef(false);

  useEffect(() => {
    // Cancel-token guard. Event handlers may fire after cleanup runs
    // because events queued in the JS event loop survive `es.close()`.
    // Without this, a stale handler from the previous runId could flip
    // localUnlock based on a NEEDS_INPUT from the old run, briefly
    // unlocking the textarea right after a fresh send.
    const ctrl = { cancelled: false };
    setLocalUnlock(false);
    const es = new EventSource(`/api/runs/${runId}/stream`, { withCredentials: true });
    const onServer = (e: MessageEvent) => {
      if (ctrl.cancelled) return;
      try {
        const p = JSON.parse(e.data) as { kind?: string };
        if (p.kind === "needs_input") setLocalUnlock(true);
      } catch {
        // ignore
      }
    };
    const onEnd = () => {
      if (ctrl.cancelled) return;
      setLocalUnlock(true);
    };
    es.addEventListener("server", onServer);
    es.addEventListener("end", onEnd);
    return () => {
      ctrl.cancelled = true;
      es.removeEventListener("server", onServer);
      es.removeEventListener("end", onEnd);
      es.close();
    };
  }, [runId]);

  const effectiveCanSend = canSend || localUnlock;

  const send = () => {
    // C2: synchronous double-fire guard. Mashing Cmd+Enter would
    // otherwise fire two POSTs against the same (old) runId before
    // `pending` flips on the next render.
    if (inFlightRef.current) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);

    // C1: capture current unlock state so we can restore it on POST
    // failure. Today's behaviour clears localUnlock then never restores
    // on 4xx/5xx — bricking the textarea until the next SSE event,
    // which won't come because no new run was spawned.
    const wasUnlocked = localUnlock;
    setLocalUnlock(false);
    inFlightRef.current = true;

    startTransition(async () => {
      try {
        const clientRequestId = crypto.randomUUID();
        const res = await fetch(`/api/runs/${runId}/message`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: trimmed, clientRequestId }),
        });
        if (!res.ok) {
          // C1: restore unlock so the operator can retry / type something else.
          setLocalUnlock(wasUnlocked);
          const j = (await res.json().catch(() => ({}))) as {
            message?: string;
            retryAfterSec?: number;
          };
          const msg = j.message ?? `HTTP ${res.status}`;
          setError(msg);
          if (res.status === 429) {
            toast.push({
              kind: "warn",
              title: "Slow down",
              body:
                j.retryAfterSec !== undefined
                  ? `Try again in ${j.retryAfterSec}s`
                  : msg,
            });
          }
          return;
        }
        // Read the new runId and propagate it up so RunLog rebinds
        // immediately. Falls back to router.refresh() if the body
        // parse fails (defence against future endpoint shape changes).
        const parsed = MessageResponse.safeParse(
          await res.json().catch(() => null),
        );
        setText("");
        if (parsed.success) {
          onRunIdChanged?.(parsed.data.runId);
        }
        // I3: refresh runs AFTER the await resolves, not before.
        // Outside startTransition wrapping so it doesn't gate `pending`
        // on the server-render round-trip. Fire-and-forget.
        router.refresh();
      } finally {
        inFlightRef.current = false;
      }
    });
  };

  const placeholder = effectiveCanSend
    ? "Type a message to continue the conversation…"
    : (blockedReason ?? "Run is still streaming — Stop or wait to chat.");

  return (
    <div className="border-t border-[color:var(--border)] px-3 py-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (effectiveCanSend) send();
        }}
        className="flex items-end gap-2"
      >
        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (effectiveCanSend) send();
            }
          }}
          placeholder={placeholder}
          disabled={!effectiveCanSend || pending}
          rows={2}
          className="flex-1 text-xs"
        />
        <Button
          {...BUTTON_INTENTS["primary-action"]}
          size="sm"
          type="submit"
          isDisabled={!effectiveCanSend || pending || !text.trim()}
        >
          {pending ? "Sending…" : "Send"}
        </Button>
      </form>
      {error ? (
        <div className="mt-1 text-xs text-red-700">Chat failed: {error}</div>
      ) : (
        <p className="mt-1 text-[10px] text-[color:var(--muted)]">
          Cmd/Ctrl+Enter to send. Messages resume the Claude session with your prompt.
        </p>
      )}
    </div>
  );
}
