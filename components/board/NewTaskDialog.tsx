"use client";

import { useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { Input } from "@heroui/react/input";
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

  const search = () => {
    setError(null);
    startSearch(async () => {
      const res = await fetch(`/api/jira/search?q=${encodeURIComponent(query)}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `search failed: HTTP ${res.status}`);
        setResults([]);
        return;
      }
      const json = (await res.json()) as { issues: JiraIssue[] };
      setResults(json.issues);
    });
  };

  const create = (jiraKey: string) => {
    setError(null);
    startCreate(async () => {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jiraKey }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `create failed: HTTP ${res.status}`);
        return;
      }
      setOpen(false);
      setQuery("");
      setResults([]);
      onCreated();
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

      {open ? (
        <div
          className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 p-8"
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <div className="z-50 w-full max-w-xl rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-background)] p-5 shadow-xl">
            <h2 className="text-base font-semibold">New task from Jira</h2>
            <p className="mt-1 text-xs text-[color:var(--color-muted-foreground)]">
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
                    <span className="font-mono text-xs text-[color:var(--color-muted-foreground)]">
                      {r.key}
                    </span>
                    <span className="flex-1">{r.fields.summary}</span>
                  </Button>
                </li>
              ))}
              {!isSearching && results.length === 0 && query ? (
                <li className="px-3 py-2 text-xs text-[color:var(--color-muted-foreground)]">
                  No results.
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
