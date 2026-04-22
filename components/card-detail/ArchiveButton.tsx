"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { Checkbox } from "@heroui/react/checkbox";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type Props = {
  taskId: string;
  jiraKey: string;
};

export function ArchiveButton({ taskId, jiraKey }: Props) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const archive = () => {
    setError(null);
    startTransition(async () => {
      const url = deleteRemote
        ? `/api/tasks/${taskId}?deleteRemote=1`
        : `/api/tasks/${taskId}`;
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        setError(body.message ?? `HTTP ${res.status}`);
        return;
      }
      router.push("/");
      router.refresh();
    });
  };

  if (!confirming) {
    return (
      <Button
        {...BUTTON_INTENTS["neutral-secondary"]}
        size="sm"
        onPress={() => setConfirming(true)}
      >
        Archive
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs">
      <span className="text-red-800">
        Archive <span className="font-mono">{jiraKey}</span>? Worktree + local branch deleted; runs + messages kept for audit.
      </span>
      <Checkbox
        isSelected={deleteRemote}
        onChange={setDeleteRemote}
        isDisabled={pending}
      >
        <span className="text-red-800">also delete remote branch + close PR</span>
      </Checkbox>
      <Button
        {...BUTTON_INTENTS["destructive"]}
        size="sm"
        onPress={archive}
        isDisabled={pending}
      >
        {pending ? "Archiving…" : "Confirm"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onPress={() => setConfirming(false)}
        isDisabled={pending}
      >
        cancel
      </Button>
      {error ? <span className="w-full text-red-800">· {error}</span> : null}
    </div>
  );
}
