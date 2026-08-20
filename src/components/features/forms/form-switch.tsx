"use client";

import { useController, useFormContext } from "react-hook-form";

import { Switch } from "@/components/ui/switch";
import { FormField } from "./form-field";

// RHF-controlled boolean toggle. Label sits next to the switch; hint/error
// render underneath.

export type FormSwitchProps = {
  name: string;
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
};

export function FormSwitch({ name, label, required, hint, className }: FormSwitchProps) {
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
      <div className="flex h-9 items-center">
        <Switch
          id={name}
          checked={field.value === true}
          onCheckedChange={(checked) => field.onChange(checked)}
          aria-invalid={fieldState.error != null}
        />
      </div>
    </FormField>
  );
}
