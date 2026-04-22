"use client";

import { Button } from "@heroui/react/button";
import { BUTTON_INTENTS } from "@/components/ui/tokens";

type Props = {
  /** The current stored value. Only last 4 chars are shown. */
  value: string;
  /** Called when the user clicks Rotate — clears the value + re-enables input. */
  onClear: () => void;
  /** Field label for the "Rotate {label}?" confirm text. */
  label: string;
};

/**
 * Renders a saved secret as ••••••••xxxx (last 4 chars) with a Rotate
 * action. Clicking Rotate calls onClear which the parent uses to set
 * the in-memory value to "" — which signals the FieldInput to render
 * the raw Input again for a fresh paste.
 */
export function MaskedSecret({ value, onClear, label }: Props) {
  const last4 = value.slice(-4);
  const masked = value.length > 4 ? `••••••••${last4}` : "••••••••";

  return (
    <div className="flex items-center gap-2 rounded-md border border-[color:var(--border)] bg-[color:var(--surface-secondary)]/40 px-3 py-2">
      <code className="flex-1 font-mono text-[12px] text-[color:var(--muted)]">
        {masked}
      </code>
      <Button
        {...BUTTON_INTENTS["retry"]}
        size="sm"
        onPress={onClear}
        aria-label={`Rotate ${label}`}
      >
        Rotate
      </Button>
    </div>
  );
}
