"use client";

import { useController, useFormContext } from "react-hook-form";

import { Input } from "@/components/ui/input";
import { FormField } from "./form-field";

// RHF-controlled date picker (native input). Form state is epoch ms (number)
// or null; conversion happens in the BROWSER's local timezone, so midnight
// stays the same calendar day for the person entering it. Day-boundary
// computations for reports always use the shop timezone server-side.

/** Epoch ms → "YYYY-MM-DD" (browser-local calendar day). Shared with the
 *  POS confirm dialog's payment-date field. */
export function msToInput(ms: unknown): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DD" → local-midnight epoch ms, or null when empty/invalid. */
export function inputToMs(value: string): number | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d).getTime();
}

export type FormDateProps = {
  name: string;
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
  /** Inclusive bounds as epoch ms (client-local day). */
  min?: number;
  max?: number;
};

export function FormDate({
  name,
  label,
  required,
  hint,
  className,
  min,
  max,
}: FormDateProps) {
  const { control } = useFormContext();
  const { field, fieldState } = useController({ control, name });

  return (
    <FormField
      label={label}
      htmlFor={name}
      required={required}
      hint={hint}
      error={fieldState.error?.message}
      className={className}
    >
      <Input
        id={name}
        type="date"
        value={msToInput(field.value)}
        onChange={(e) => field.onChange(inputToMs(e.target.value))}
        min={min !== undefined ? msToInput(min) : undefined}
        max={max !== undefined ? msToInput(max) : undefined}
        aria-invalid={fieldState.error != null}
      />
    </FormField>
  );
}
