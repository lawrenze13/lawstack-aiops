"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
};

export function ChatBox({ runId, canSend, blockedReason }: Props) {
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

  useEffect(() => {
    setLocalUnlock(false);
    const es = new EventSource(`/api/runs/${runId}/stream`, { withCredentials: true });
    const onServer = (e: MessageEvent) => {
      try {
        const p = JSON.parse(e.data) as { kind?: string };
        if (p.kind === "needs_input") setLocalUnlock(true);
      } catch {
        // ignore
      }
    };
    const onEnd = () => setLocalUnlock(true);
    es.addEventListener("server", onServer);
    es.addEventListener("end", onEnd);
    return () => {
      es.removeEventListener("server", onServer);
      es.removeEventListener("end", onEnd);
      es.close();
    };
  }, [runId]);

  const effectiveCanSend = canSend || localUnlock;

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    // Sending kicks off a new turn → immediately lock back.
    setLocalUnlock(false);
    startTransition(async () => {
      const clientRequestId = crypto.randomUUID();
      const res = await fetch(`/api/runs/${runId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed, clientRequestId }),
      });
      if (!res.ok) {
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
      setText("");
      router.refresh();
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
