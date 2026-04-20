"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Props = {
  runId: string;
  /** Disables Send while the parent run is still streaming. */
  canSend: boolean;
  /** Human reason shown in the placeholder when canSend=false. */
  blockedReason?: string;
};

export function ChatBox({ runId, canSend, blockedReason }: Props) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setError(null);
    startTransition(async () => {
      const clientRequestId = crypto.randomUUID();
      const res = await fetch(`/api/runs/${runId}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: trimmed, clientRequestId }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        setError(j.message ?? `HTTP ${res.status}`);
        return;
      }
      setText("");
      router.refresh();
    });
  };

  const placeholder = canSend
    ? "Type a message to continue the conversation…"
    : (blockedReason ?? "Run is still streaming — Stop or wait to chat.");

  return (
    <div className="border-t border-[color:var(--color-border)] px-3 py-2">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) send();
        }}
        className="flex items-end gap-2"
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              if (canSend) send();
            }
          }}
          placeholder={placeholder}
          disabled={!canSend || pending}
          rows={2}
          className="flex-1 resize-y rounded-md border border-[color:var(--color-border)] bg-[color:var(--color-card)] px-2 py-1 text-xs placeholder:text-[color:var(--color-muted-foreground)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canSend || pending || !text.trim()}
          className="rounded-md bg-[color:var(--color-foreground)] px-3 py-1.5 text-xs font-medium text-[color:var(--color-background)] disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send"}
        </button>
      </form>
      {error ? (
        <div className="mt-1 text-xs text-red-700">Chat failed: {error}</div>
      ) : (
        <p className="mt-1 text-[10px] text-[color:var(--color-muted-foreground)]">
          Cmd/Ctrl+Enter to send. Messages resume the Claude session with your prompt.
        </p>
      )}
    </div>
  );
}
