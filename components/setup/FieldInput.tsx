"use client";

import { Input } from "@heroui/react/input";
import { TextArea } from "@heroui/react/textarea";
import { Checkbox } from "@heroui/react/checkbox";
import type { SettingField } from "@/server/lib/settingsSchema";
import { MaskedSecret } from "./MaskedSecret";

type Props = {
  field: SettingField;
  value: unknown;
  onChange: (value: unknown) => void;
  /** True after the field was set at least once (disables inputs for mask=true unless Rotate is clicked). */
  previouslySet?: boolean;
};

/**
 * Polymorphic input that renders the right HeroUI primitive for
 * `field.kind`. Used by both the wizard and /admin/settings.
 */
export function FieldInput({ field, value, onChange, previouslySet }: Props) {
  if (field.mask && previouslySet) {
    return (
      <MaskedSecret
        value={typeof value === "string" ? value : ""}
        onClear={() => onChange("")}
        label={field.label}
      />
    );
  }

  switch (field.kind) {
    case "boolean":
      return (
        <Checkbox
          isSelected={Boolean(value)}
          onChange={(checked) => onChange(Boolean(checked))}
        >
          <span className="text-xs">{field.description}</span>
        </Checkbox>
      );
    case "textarea":
      return (
        <TextArea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          placeholder={field.placeholder}
          className="w-full"
        />
      );
    case "password":
      return (
        <Input
          type="password"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          autoComplete="off"
        />
      );
    case "number":
      return (
        <Input
          type="number"
          value={value == null ? "" : String(value)}
          onChange={(e) => {
            const n = e.target.value === "" ? null : Number(e.target.value);
            onChange(n);
          }}
          min={field.min}
          max={field.max}
          placeholder={field.placeholder}
        />
      );
    case "url":
    case "email":
    case "text":
    case "domain-list":
    case "select":
    default:
      return (
        <Input
          type={
            field.kind === "url"
              ? "url"
              : field.kind === "email"
                ? "email"
                : "text"
          }
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
        />
      );
  }
}
