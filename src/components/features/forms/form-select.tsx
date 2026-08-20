"use client";

import { useController, useFormContext } from "react-hook-form";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FormField } from "./form-field";

// RHF-controlled dropdown for short option lists. For long/searchable lists
// use FormCombobox instead.

/** `disabled` greys an option out but keeps it visible — used where the list
 * is a fixed journey (order statuses) and hiding steps would lose the map. */
export type FormSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

export type FormSelectProps = {
  name: string;
  label: string;
  options: FormSelectOption[];
  placeholder?: string;
  required?: boolean;
  hint?: string;
  className?: string;
  disabled?: boolean;
};

export function FormSelect({
  name,
  label,
  options,
  placeholder,
  required,
  hint,
  className,
  disabled,
}: FormSelectProps) {
  const { control } = useFormContext();
  const { field, fieldState } = useController({ control, name });

  return (
    <FormField
      label={label}
      required={required}
      hint={hint}
      error={fieldState.error?.message}
      className={className}
    >
      <Select
        value={field.value ?? ""}
        onValueChange={(value) => field.onChange(value)}
        disabled={disabled}
        // Base UI shows the RAW value in the trigger without this map —
        // options are already { value, label }, so pass them through.
        items={options}
      >
        <SelectTrigger className="w-full" aria-invalid={fieldState.error != null}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}
