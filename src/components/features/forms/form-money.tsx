"use client";

import { useController, useFormContext } from "react-hook-form";
import { z } from "zod";

import { Input } from "@/components/ui/input";
import { t } from "@/lib/utils";
import { FormField } from "./form-field";

// RHF-controlled money field. The form stores a STRING like "12.50" (decimal,
// never floats); the parent converts with inputToCents() before calling the
// server, which re-validates integer cents. Keyboard shows the number pad.

/** Decimal money input: digits with at most 2 decimals, e.g. "12.50". */
export const moneyInputSchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}(\.\d{1,2})?$/, t().products.invalidMoney);

/** Optional money: empty string is allowed (empty = none), else same rule. */
export const optionalMoneySchema = z
  .string()
  .trim()
  .refine((v) => v === "" || /^\d{1,9}(\.\d{1,2})?$/.test(v), t().products.invalidMoney);

export type FormMoneyProps = {
  name: string;
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
};

export function FormMoney({
  name,
  label,
  required,
  hint,
  className,
  placeholder = "0.00",
  disabled,
}: FormMoneyProps) {
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
        inputMode="decimal"
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={fieldState.error != null}
        {...field}
        value={field.value ?? ""}
      />
    </FormField>
  );
}
