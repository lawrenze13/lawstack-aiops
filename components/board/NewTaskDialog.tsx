"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { Input } from "@heroui/react/input";
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
} from "@heroui/react/modal";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type JiraIssue = {
  key: string;
  fields: { summary: string };
};

type Props = {
  onCreated: () => void;
};

export function NewTaskDialog({ onCreated }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<JiraIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isSearching, startSearch] = useTransition();
  const [isCreating, startCreate] = useTransition();
  // Abort in-flight fetches if the dialog closes mid-request — otherwise the
  // resolver runs against an unmounted tree and router.refresh fires late.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const search = () => {
    setError(null);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    startSearch(async () => {
      try {
        const res = await fetch(`/api/jira/search?q=${encodeURIComponent(query)}`, {
          cache: "no-store",
          signal: ac.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          setError(body.message ?? `search failed: HTTP ${res.status}`);
          setResults([]);
          return;
        }
        const json = (await res.json()) as { issues: JiraIssue[] };
        setResults(json.issues);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError((err as Error).message);
        }
      }
    });
  };

  const create = (jiraKey: string) => {
    setError(null);
    const ac = new AbortController();
    abortRef.current = ac;
    startCreate(async () => {
      try {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jiraKey }),
          signal: ac.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          setError(body.message ?? `create failed: HTTP ${res.status}`);
          return;
        }
        // Close first — onCreated (which fires router.refresh) runs AFTER
        // the Modal's exit animation to avoid the ghost-portal race
        // where router.refresh reparents the subtree mid-animation.
        // See the heroui-migration plan's risk table row for this.
        setOpen(false);
        setQuery("");
        setResults([]);
        // Single rAF + short settle for Modal animation (~200ms in v3). If
        // the Modal adds a firm onAnimationComplete later we swap to that.
        setTimeout(() => onCreated(), 230);
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError((err as Error).message);
        }
      }
    });
  };

  return (
    <>
      <Button
        {...BUTTON_INTENTS["primary-action"]}
        size="sm"
        onPress={() => setOpen(true)}
      >
        New Task
      </Button>

      <Modal isOpen={open} onOpenChange={setOpen}>
        <ModalBackdrop>
          <ModalContainer size="md" placement="top">
            <ModalDialog>
              <ModalHeader>
                <ModalHeading>New task from Jira</ModalHeading>
              </ModalHeader>
              <ModalBody>
                <p className="text-xs text-[color:var(--muted)]">
                  Search by ticket key (e.g. <span className="font-mono">MP-1050</span>) or summary
                  text.
                </p>

                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (query.trim()) search();
                  }}
                >
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="MP-1050 or 'fix login redirect'"
                    className="flex-1"
                    autoFocus
                  />
                  <Button
                    {...BUTTON_INTENTS["neutral-secondary"]}
                    size="md"
                    type="submit"
                    isDisabled={isSearching || !query.trim()}
                  >
                    {isSearching ? "Searching…" : "Search"}
                  </Button>
                </form>

                {error ? (
                  <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700">
                    {error}
                  </div>
                ) : null}

                <ul className="mt-3 max-h-72 overflow-y-auto">
                  {results.map((r) => (
                    <li key={r.key}>
                      <Button
                        variant="ghost"
                        size="md"
                        fullWidth
                        onPress={() => create(r.key)}
                        isDisabled={isCreating}
                        className="justify-start gap-3 text-left"
                      >
                        <span className="font-mono text-xs text-[color:var(--muted)]">
                          {r.key}
                        </span>
                        <span className="flex-1">{r.fields.summary}</span>
                      </Button>
                    </li>
                  ))}
                  {!isSearching && results.length === 0 && query ? (
                    <li className="px-3 py-2 text-xs text-[color:var(--muted)]">
                      No results.
                    </li>
                  ) : null}
                </ul>
              </ModalBody>
            </ModalDialog>
          </ModalContainer>
        </ModalBackdrop>
      </Modal>
    </>
  );
}
