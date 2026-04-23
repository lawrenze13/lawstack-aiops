"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

export function KillRunButton({ runId }: { runId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  return (
    <Button
      {...BUTTON_INTENTS["destructive"]}
      size="sm"
      isDisabled={pending}
      onPress={() => {
        setErr(null);
        start(async () => {
          const res = await fetch("/api/admin/kill-run", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ runId }),
          });
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as { message?: string };
            setErr(j.message ?? `HTTP ${res.status}`);
            return;
          }
          router.refresh();
        });
      }}
    >
      {pending ? "…" : err ? "retry" : "kill"}
    </Button>
  );
}
