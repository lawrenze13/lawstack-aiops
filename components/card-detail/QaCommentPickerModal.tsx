"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { useToast } from "@/components/toast/ToastHost";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type Comment = {
  id: string;
  author: string;
  created: string;
  body: string;
};

type Props = {
  taskId: string;
  open: boolean;
  onClose: () => void;
};

/**
 * Modal for picking which Jira comments are actual QA findings before
 * spawning a Fix from QA cycle. Fetches the comments-since-done set
 * via GET /api/tasks/:id/qa-fix/comments on open; on submit POSTs to
 * /api/tasks/:id/qa-fix/start with the selected comment IDs.
 *
 * The list shows each comment as a checkbox row (author · created ·
 * truncated body with click-to-expand). At least one selection is
 * required — the Run button is disabled otherwise.
 *
 * Errors:
 *   - Fetch failure: "Jira unreachable" banner with a Retry button.
 *   - Empty comments-since-done: "No QA comments yet" with Refresh.
 *   - Submit failure: in-modal banner; selections preserved so the
 *     operator can retry without re-checking boxes.
 */
export function QaCommentPickerModal({ taskId, open, onClose }: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Reset on close so reopens fetch fresh state.
  useEffect(() => {
    if (!open) {
      setSelected(new Set());
      setExpanded(new Set());
      setComments(null);
      setFetchError(null);
      setSubmitError(null);
    }
  }, [open]);

  const fetchComments = () => {
    setLoading(true);
    setFetchError(null);
    fetch(`/api/tasks/${taskId}/qa-fix/comments`)
      .then(async (res) => {
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(j.message ?? `HTTP ${res.status}`);
        }
        return res.json() as Promise<{ comments: Comment[]; doneAt: string | null }>;
      })
      .then((data) => {
        setComments(data.comments);
        setLoading(false);
      })
      .catch((err: Error) => {
        setFetchError(err.message);
        setLoading(false);
      });
  };

  useEffect(() => {
    if (open && comments === null && !loading) {
      fetchComments();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submit = () => {
    if (selected.size === 0) return;
    setSubmitError(null);
    startTransition(async () => {
      const res = await fetch(`/api/tasks/${taskId}/qa-fix/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ qaCommentIds: [...selected] }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        runId?: string;
        message?: string;
      };
      if (!res.ok || !json.ok) {
        setSubmitError(json.message ?? `HTTP ${res.status}`);
        return;
      }
      toast.push({
        kind: "info",
        title: "QA fix started",
        body: `${selected.size} finding${
          selected.size === 1 ? "" : "s"
        } sent to brainstorm.`,
      });
      onClose();
      router.refresh();
    });
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-[color:var(--border)] bg-[color:var(--surface)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="border-b border-[color:var(--border)] px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[color:var(--muted)]">
            qa fix · pick findings
          </div>
          <h3 className="mt-1 text-sm font-semibold">
            Which Jira comments are QA findings?
          </h3>
          <p className="mt-1 text-xs text-[color:var(--muted)]">
            Pick the comments QA left after the PR landed. They&rsquo;ll seed a
            fresh brainstorm; the cascade re-runs through plan + review +
            implement.
          </p>
        </header>

        <div className="max-h-[50vh] overflow-y-auto p-4">
          {loading ? (
            <p className="py-6 text-center text-xs text-[color:var(--muted)]">
              Loading comments…
            </p>
          ) : fetchError ? (
            <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">
              <div className="font-medium">Couldn&rsquo;t reach Jira</div>
              <div className="mt-1">{fetchError}</div>
              <button
                type="button"
                onClick={fetchComments}
                className="mt-2 text-[11px] text-red-700 underline-offset-2 hover:underline"
              >
                Retry
              </button>
            </div>
          ) : !comments || comments.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-xs text-[color:var(--muted)]">
                No comments since the implementation landed.
              </p>
              <button
                type="button"
                onClick={fetchComments}
                className="mt-2 text-[11px] text-[color:var(--accent)] underline-offset-2 hover:underline"
              >
                Refresh
              </button>
            </div>
          ) : (
            <ul className="space-y-2">
              {comments.map((c) => {
                const isOpen = expanded.has(c.id);
                const truncated = c.body.length > 200;
                const display = isOpen || !truncated
                  ? c.body
                  : c.body.slice(0, 200) + "…";
                return (
                  <li
                    key={c.id}
                    className="rounded border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/40 p-3"
                  >
                    <label className="flex cursor-pointer items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggle(c.id)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 text-xs">
                        <div className="flex items-baseline gap-2">
                          <span className="font-medium">{c.author}</span>
                          <span className="font-mono text-[10px] text-[color:var(--muted)]">
                            {formatRelative(c.created)}
                          </span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-[color:var(--foreground)]">
                          {display}
                        </p>
                        {truncated ? (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              setExpanded((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.id)) next.delete(c.id);
                                else next.add(c.id);
                                return next;
                              });
                            }}
                            className="mt-1 text-[10px] text-[color:var(--muted)] underline-offset-2 hover:text-[color:var(--accent)] hover:underline"
                          >
                            {isOpen ? "show less" : "show more"}
                          </button>
                        ) : null}
                      </div>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {submitError ? (
          <div className="mx-4 mb-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">
            {submitError}
          </div>
        ) : null}

        <footer className="flex items-center justify-between gap-2 border-t border-[color:var(--border)] px-4 py-3">
          <span className="text-[11px] text-[color:var(--muted)]">
            {selected.size} selected
          </span>
          <div className="flex gap-2">
            <Button {...BUTTON_INTENTS["neutral-secondary"]} size="sm" onPress={onClose}>
              Cancel
            </Button>
            <Button
              {...BUTTON_INTENTS["primary-action"]}
              size="sm"
              onPress={submit}
              isDisabled={selected.size === 0 || pending}
            >
              {pending ? "Starting…" : `Run fix (${selected.size})`}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function formatRelative(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return iso;
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  if (diff < 604800_000) return `${Math.floor(diff / 86400_000)}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}
