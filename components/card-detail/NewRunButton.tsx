"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react/button";
import { TextArea } from "@heroui/react/textarea";
import { ListBox } from "@heroui/react/list-box";
import { ListBoxItem } from "@heroui/react/list-box-item";
import {
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalHeader,
  ModalHeading,
} from "@heroui/react/modal";
import {
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectIndicator,
  SelectPopover,
} from "@heroui/react/select";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

export type NewRunAgentOption = {
  id: string;
  name: string;
  lanes: Array<"brainstorm" | "plan" | "review" | "implement">;
};

type Props = {
  taskId: string;
  /** Disable when another run is live — can't have two concurrent runs on one task. */
  runActive: boolean;
  /** Everything that can be dispatched from here. */
  agents: NewRunAgentOption[];
};

/**
 * "+ New Run" — opens a centered modal where the user picks an agent +
 * lane + optional extra prompt, then POSTs to `/api/tasks/:id/runs`.
 * Disabled while any run is live so two subprocesses never contend
 * for the same worktree.
 */
export function NewRunButton({ taskId, runActive, agents }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string>(agents[0]?.id ?? "");
  const selected = agents.find((a) => a.id === agentId) ?? agents[0];
  const [lane, setLane] = useState<NewRunAgentOption["lanes"][number]>(
    selected?.lanes[0] ?? "brainstorm",
  );
  const [extra, setExtra] = useState("");
  const [interactive, setInteractive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const pickAgent = (id: string) => {
    setAgentId(id);
    const a = agents.find((x) => x.id === id);
    if (a && !a.lanes.includes(lane)) setLane(a.lanes[0]!);
  };

  const reset = () => {
    setAgentId(agents[0]?.id ?? "");
    setLane(agents[0]?.lanes[0] ?? "brainstorm");
    setExtra("");
    setInteractive(false);
    setError(null);
  };

  const submit = () => {
    if (!agentId || !lane) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/tasks/${taskId}/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId,
          lane,
          additionalPrompt: extra.trim() || undefined,
          interactive: lane === "implement" ? interactive : undefined,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) {
        setError(json.message ?? `HTTP ${res.status}`);
        return;
      }
      setOpen(false);
      reset();
      router.refresh();
    });
  };

  return (
    <>
      <Button
        {...BUTTON_INTENTS["neutral-secondary"]}
        size="sm"
        onPress={() => setOpen(true)}
        isDisabled={runActive}
      >
        + New Run
      </Button>

      <Modal isOpen={open} onOpenChange={setOpen}>
        <ModalBackdrop>
          <ModalContainer size="md" placement="top">
            <ModalDialog>
              <ModalHeader>
                <ModalHeading>Start a new run</ModalHeading>
              </ModalHeader>
              <ModalBody>
                <p className="text-xs text-[color:var(--muted)]">
                  Pick the agent and lane. The agent&rsquo;s built-in prompt
                  is always used; extra prompt is appended under an
                  &ldquo;Operator notes&rdquo; section.
                </p>

                <div className="mt-4 space-y-4">
                  <Field label="Agent">
                    <SelectRoot
                      aria-label="Agent"
                      selectedKey={agentId}
                      onSelectionChange={(k) => pickAgent(String(k))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                        <SelectIndicator />
                      </SelectTrigger>
                      <SelectPopover>
                        <ListBox>
                          {agents.map((a) => (
                            <ListBoxItem key={a.id} id={a.id}>
                              {a.name} ({a.id})
                            </ListBoxItem>
                          ))}
                        </ListBox>
                      </SelectPopover>
                    </SelectRoot>
                  </Field>

                  <Field label="Lane">
                    <SelectRoot
                      aria-label="Lane"
                      selectedKey={lane}
                      onSelectionChange={(k) =>
                        setLane(String(k) as typeof lane)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                        <SelectIndicator />
                      </SelectTrigger>
                      <SelectPopover>
                        <ListBox>
                          {(selected?.lanes ?? []).map((l) => (
                            <ListBoxItem key={l} id={l}>
                              {l}
                            </ListBoxItem>
                          ))}
                        </ListBox>
                      </SelectPopover>
                    </SelectRoot>
                  </Field>

                  <Field label="Extra prompt (optional)">
                    <TextArea
                      value={extra}
                      onChange={(e) => setExtra(e.target.value)}
                      rows={4}
                      maxLength={4000}
                      placeholder={
                        'e.g. "focus on the migration files only" or "skip the styling pass"'
                      }
                      className="w-full rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-[color:var(--foreground)] placeholder:text-[color:var(--muted)] focus:border-[color:var(--accent)] focus:outline-none"
                    />
                    <p className="mt-1 text-[10px] text-[color:var(--muted)]">
                      {extra.length}/4000 · Appended to the agent&rsquo;s
                      built-in prompt. Leave empty for default behaviour.
                    </p>
                  </Field>

                  {lane === "implement" ? (
                    <label className="flex items-start gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/30 p-2 text-[11px]">
                      <input
                        type="checkbox"
                        checked={interactive}
                        onChange={(e) => setInteractive(e.target.checked)}
                        className="mt-0.5 h-3.5 w-3.5 accent-[color:var(--accent)]"
                      />
                      <span>
                        <span className="font-medium text-[color:var(--foreground)]">
                          Interactive mode
                        </span>{" "}
                        <span className="text-[color:var(--muted)]">
                          — agent pauses before each Bash command for review.
                        </span>
                      </span>
                    </label>
                  ) : null}

                  {error ? (
                    <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                      {error}
                    </div>
                  ) : null}
                </div>

                <div className="mt-5 flex items-center justify-end gap-2 border-t border-[color:var(--border)] pt-4">
                  <Button
                    {...BUTTON_INTENTS["neutral-secondary"]}
                    size="sm"
                    onPress={() => setOpen(false)}
                    isDisabled={pending}
                  >
                    Cancel
                  </Button>
                  <Button
                    {...BUTTON_INTENTS["primary-action"]}
                    size="sm"
                    onPress={submit}
                    isDisabled={pending || !agentId || !lane}
                  >
                    {pending ? "Starting…" : "Start run"}
                  </Button>
                </div>
              </ModalBody>
            </ModalDialog>
          </ModalContainer>
        </ModalBackdrop>
      </Modal>
    </>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.12em] text-[color:var(--muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}
