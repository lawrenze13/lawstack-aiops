import { Chip } from "@heroui/react/chip";

type Props = {
  /** Number of QA fix cycles started for this task. Hidden when 0. */
  count: number;
};

/**
 * Small chip on the card header surfacing how many QA-fix cycles have
 * been triggered for this task. Hidden on tasks that haven't gone
 * through QA yet (the common case).
 *
 * Counts STARTED cycles, not completed — a task in mid-cycle still
 * shows the bumped number so the operator sees the loop is happening.
 */
export function QaCycleChip({ count }: Props) {
  if (count <= 0) return null;
  return (
    <Chip
      color="warning"
      variant="soft"
      size="sm"
      title={`${count} QA fix cycle${count === 1 ? "" : "s"} started for this task`}
    >
      QA fix · {count}
    </Chip>
  );
}
