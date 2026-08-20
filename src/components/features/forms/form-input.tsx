"use client";

import { useController, useFormContext } from "react-hook-form";

import { Input } from "@/components/ui/input";
import { FormField } from "./form-field";

// RHF-controlled text/number input. Value is stored as-is in the form state;
// for numeric fields pair with z.coerce.number() in the Zod schema.

export type FormInputProps = {
  name: string;
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
} & Omit<
  React.ComponentProps<"input">,
  "name" | "value" | "onChange" | "onBlur" | "ref" | "id"
>;

export function FormInput({
  name,
  label,
  required,
  hint,
  className,
  type = "text",
  ...props
}: FormInputProps) {
  const { control } = useFormContext();
  const { field, fieldState } = useController({ control, name });
  const inputId = name;

  return (
    <FormField
      label={label}
      htmlFor={inputId}
      required={required}
      hint={hint}
      error={fieldState.error?.message}
      className={className}
    >
      <Input
        id={inputId}
        type={type}
        aria-invalid={fieldState.error != null}
        {...props}
        {...field}
        value={field.value ?? ""}
      />
    </FormField>
  );
}
