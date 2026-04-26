"use client";

import { useState, useTransition } from "react";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

export type UserTokenRow = {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "member" | "viewer";
  hasJira: boolean;
  hasGithub: boolean;
  hasGit: boolean;
};

type Props = {
  rows: UserTokenRow[];
  /** Current admin's userId — Clear buttons disabled on their own row to
   *  prevent accidental self-clearing from this admin surface (use
   *  /profile for that). */
  currentAdminId: string;
};

/**
 * Per-user token-status table. Admin-only — never displays decrypted
 * values, only "configured / not configured" chips. Each chip is
 * clickable to clear that user's block via the credentials API
 * (`?for=<userId>`).
 */
export function UsersTokenStatus({ rows, currentAdminId }: Props) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[color:var(--border)]">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[color:var(--border)] bg-[color:var(--surface-secondary)]/40 text-left">
            <Th>User</Th>
            <Th>Role</Th>
            <Th>Jira</Th>
            <Th>GitHub</Th>
            <Th>Git identity</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <UserRow
              key={row.id}
              row={row}
              isSelf={row.id === currentAdminId}
            />
          ))}
        </tbody>
      </table>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-[color:var(--muted)]">
          No users.
        </p>
      ) : null}
    </div>
  );
}

function UserRow({ row, isSelf }: { row: UserTokenRow; isSelf: boolean }) {
  return (
    <tr className="border-b border-[color:var(--border)] last:border-0">
      <td className="px-4 py-3">
        <div className="text-sm">{row.name ?? "—"}</div>
        <div className="font-mono text-[10px] text-[color:var(--muted)]">
          {row.email}
        </div>
      </td>
      <td className="px-4 py-3">
        <span
          className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] ${
            row.role === "admin"
              ? "bg-[color:var(--accent)]/15 text-[color:var(--accent)]"
              : "bg-[color:var(--surface-secondary)]/60 text-[color:var(--muted)]"
          }`}
        >
          {row.role}
        </span>
      </td>
      <td className="px-4 py-3">
        <ServiceChip
          configured={row.hasJira}
          userId={row.id}
          service="jira"
          isSelf={isSelf}
        />
      </td>
      <td className="px-4 py-3">
        <ServiceChip
          configured={row.hasGithub}
          userId={row.id}
          service="github"
          isSelf={isSelf}
        />
      </td>
      <td className="px-4 py-3">
        <ServiceChip
          configured={row.hasGit}
          userId={row.id}
          service="git"
          isSelf={isSelf}
        />
      </td>
    </tr>
  );
}

function ServiceChip({
  configured,
  userId,
  service,
  isSelf,
}: {
  configured: boolean;
  userId: string;
  service: "jira" | "github" | "git";
  isSelf: boolean;
}) {
  const [cleared, setCleared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (!configured) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
        instance default
      </span>
    );
  }

  if (cleared) {
    return (
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
        cleared
      </span>
    );
  }

  const clear = () => {
    if (isSelf) return;
    if (!confirm(`Clear this user's ${service} credentials?`)) return;
    setError(null);
    start(async () => {
      try {
        const res = await fetch(
          `/api/profile/credentials/${service}?for=${encodeURIComponent(userId)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { message?: string };
          setError(body.message ?? `HTTP ${res.status}`);
          return;
        }
        setCleared(true);
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex w-fit items-center gap-1 rounded-full bg-[color:var(--accent)]/15 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--accent)]">
        ✓ configured
      </span>
      <Button
        {...BUTTON_INTENTS["neutral-secondary"]}
        size="sm"
        onPress={clear}
        isDisabled={pending || isSelf}
      >
        {pending ? "Clearing…" : isSelf ? "(use /profile)" : "Clear"}
      </Button>
      {error ? (
        <span className="text-[10px] text-red-600">{error}</span>
      ) : null}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-4 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
      {children}
    </th>
  );
}
