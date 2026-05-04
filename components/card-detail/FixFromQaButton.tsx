"use client";

import { useState } from "react";
import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";
import { QaCommentPickerModal } from "./QaCommentPickerModal";

type Props = {
  taskId: string;
  /** Card's current_lane. Button only shows on `done`. */
  currentLane: string;
  /** Owner-or-admin gate. */
  canControl: boolean;
  /** True when any run on this task is currently active — blocks the
   *  button to prevent racing a Fix from QA into a still-streaming run. */
  runActive: boolean;
};

/**
 * "Fix from QA" — launches the QA-fix loop. Visible only on `done`-lane
 * cards (no other lane has post-merge QA findings to act on) where the
 * operator is owner/admin and no run is currently active.
 *
 * Click → opens QaCommentPickerModal → operator picks Jira comments →
 * POST /api/tasks/:id/qa-fix/start → fresh ce:brainstorm spawns with
 * the QA findings prepended; cascade carries it through plan + review;
 * Layer B's cycle-aware Approve & PR + Implement gates handle the
 * commit/push.
 */
export function FixFromQaButton({
  taskId,
  currentLane,
  canControl,
  runActive,
}: Props) {
  const [modalOpen, setModalOpen] = useState(false);

  if (!canControl) return null;
  if (currentLane !== "done") return null;

  return (
    <>
      <Button
        {...BUTTON_INTENTS["retry"]}
        size="sm"
        isDisabled={runActive}
        onPress={() => setModalOpen(true)}
      >
        {runActive ? "⇡ Fix from QA (wait)" : "⇡ Fix from QA"}
      </Button>
      <QaCommentPickerModal
        taskId={taskId}
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </>
  );
}
