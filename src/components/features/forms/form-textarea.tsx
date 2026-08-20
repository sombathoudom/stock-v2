"use client";

import { useController, useFormContext } from "react-hook-form";

import { Textarea } from "@/components/ui/textarea";
import { FormField } from "./form-field";

// RHF-controlled multiline text (address, notes).

export type FormTextareaProps = {
  name: string;
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
  rows?: number;
  placeholder?: string;
};

export function FormTextarea({
  name,
  label,
  required,
  hint,
  className,
  rows = 3,
  placeholder,
}: FormTextareaProps) {
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
      <Textarea
        id={name}
        rows={rows}
        placeholder={placeholder}
        aria-invalid={fieldState.error != null}
        {...field}
        value={field.value ?? ""}
      />
    </FormField>
  );
}
