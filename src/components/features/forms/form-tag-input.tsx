"use client";

import { PlusSignIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useController, useFormContext } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/utils";
import { FormField } from "./form-field";

// RHF-controlled tag list (product sizes / colors): type + Enter (or the Add
// button) appends a chip, the × on a chip removes it. Duplicates (case-
// insensitive) are ignored here AND rejected by the server re-validation.

export type FormTagInputProps = {
  name: string;
  label: string;
  required?: boolean;
  hint?: string;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  maxTags?: number;
  disabled?: boolean;
};

export function FormTagInput({
  name,
  label,
  required,
  hint,
  className,
  placeholder,
  maxLength = 20,
  maxTags = 30,
  disabled,
}: FormTagInputProps) {
  const { control } = useFormContext();
  const { field, fieldState } = useController({ control, name });
  const [draft, setDraft] = useState("");

  const value: string[] = Array.isArray(field.value) ? field.value : [];

  function add() {
    const tag = draft.trim();
    if (!tag || value.length >= maxTags) return;
    // Ignore case-insensitive duplicates (server does the same).
    if (value.some((v) => v.toLowerCase() === tag.toLowerCase())) {
      setDraft("");
      return;
    }
    field.onChange([...value, tag]);
    setDraft("");
  }

  function remove(tag: string) {
    field.onChange(value.filter((v) => v !== tag));
  }

  return (
    <FormField
      label={label}
      htmlFor={name}
      required={required}
      hint={hint}
      error={fieldState.error?.message}
      className={className}
    >
      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Input
            id={name}
            value={draft}
            maxLength={maxLength}
            placeholder={placeholder}
            disabled={disabled || value.length >= maxTags}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            aria-invalid={fieldState.error != null}
          />
          <Button
            type="button"
            variant="outline"
            disabled={disabled || !draft.trim() || value.length >= maxTags}
            onClick={add}
          >
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
            {t().products.addTag}
          </Button>
        </div>
        {value.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {value.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full border bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground"
              >
                {tag}
                <button
                  type="button"
                  aria-label={`${t().common.delete} ${tag}`}
                  disabled={disabled}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                  onClick={() => remove(tag)}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </FormField>
  );
}
