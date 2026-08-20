"use client";

import { useMemo, useState } from "react";
import { useController, useFormContext } from "react-hook-form";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { InputGroup } from "@/components/ui/input-group";
import { t } from "@/lib/utils";
import { FormField } from "./form-field";

// RHF-controlled searchable dropdown for long lists: typing filters the
// options (case-insensitive label match). The input is uncontrolled (Base UI
// owns it); the query is tracked through onInputValueChange and reset on
// selection so the closed input shows the selected value.

export type FormComboboxOption = { value: string; label: string };

export type FormComboboxProps = {
  name: string;
  label: string;
  options: FormComboboxOption[];
  placeholder?: string;
  required?: boolean;
  hint?: string;
  className?: string;
  disabled?: boolean;
  /** Free text allowed: when the typed query matches no existing option,
   * a "Use \"query\"" option appears and selecting it stores the raw text
   * (used for expense categories — the list grows itself). */
  creatable?: boolean;
};

export function FormCombobox({
  name,
  label,
  options,
  placeholder,
  required,
  hint,
  className,
  disabled,
  creatable,
}: FormComboboxProps) {
  const { control } = useFormContext();
  const { field, fieldState } = useController({ control, name });
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim();
    const lower = q.toLowerCase();
    if (!q) return options;
    const matches = options.filter((option) =>
      option.label.toLowerCase().includes(lower)
    );
    if (creatable && !matches.some((option) => option.label.toLowerCase() === lower)) {
      // The raw string is the value; itemToStringLabel falls back to it, so
      // the input shows the typed text after selection (it's not in the map).
      matches.push({ value: q, label: t().common.useTyped.replace("{value}", q) });
    }
    return matches;
  }, [options, query, creatable]);

  // Value → label lookup for Base UI's itemToStringLabel: the input shows
  // labels, not raw ids, after a selection (and on mount with a prefilled
  // value). Misses fall back to the value itself.
  const labelByValue = useMemo(
    () => new Map(options.map((option) => [option.value, option.label])),
    [options]
  );

  return (
    <FormField
      label={label}
      required={required}
      hint={hint}
      error={fieldState.error?.message}
      className={className}
    >
      <Combobox
        items={filtered.map((option) => option.value)}
        itemToStringLabel={(item) => {
          if (item == null) return "";
          const value =
            typeof item === "object" && "value" in item
              ? String((item as { value: unknown }).value)
              : String(item);
          return labelByValue.get(value) ?? value;
        }}
        value={(field.value as string | undefined) ?? null}
        onValueChange={(value) => {
          field.onChange(value ?? "");
          setQuery("");
        }}
        // Only user typing drives the filter — Base UI's programmatic fills
        // (selection sync, mount) arrive with a different reason and must
        // not replace the query with the selected label.
        onInputValueChange={(inputValue, eventDetails) => {
          if (eventDetails?.reason === "input-change") setQuery(inputValue);
        }}
        disabled={disabled}
      >
        <InputGroup className="w-full">
          <ComboboxInput
            placeholder={placeholder ?? label}
            disabled={disabled}
            showClear
            aria-invalid={fieldState.error != null}
            // Select the current value on focus so typing replaces it
            // instead of inserting into the middle.
            onFocus={(e) => (e.target as HTMLInputElement).select()}
          />
        </InputGroup>
        <ComboboxContent>
          <ComboboxEmpty>{t().common.noResults}</ComboboxEmpty>
          <ComboboxList>
            {filtered.map((option) => (
              <ComboboxItem key={option.value} value={option.value}>
                {option.label}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </FormField>
  );
}
