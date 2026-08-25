"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Cancel01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import { FormCombobox } from "@/components/features/forms/form-combobox";
import { FormDate } from "@/components/features/forms/form-date";
import { FormMoney, moneyInputSchema } from "@/components/features/forms/form-money";
import { FormTextarea } from "@/components/features/forms/form-textarea";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inputToCents, t, toastError } from "@/lib/utils";

// One shared form for the create and edit expense pages. The server
// re-validates everything (convex/expenses.ts) — this is UX validation.
// Categories are selected from managed records; the quick-add dialog creates
// one explicitly instead of silently accepting spelling variants.

const expenseSchema = z.object({
  amount: moneyInputSchema,
  category: z.string().trim().min(1, t().common.required).max(100),
  spentAt: z
    .number()
    .nullable()
    .refine((v): v is number => v != null, t().common.required),
  note: z.string().max(500),
});

// z.number().nullable() widens the raw input type (number | null); the
// resolver coerces it to number. Mirror the settings-page pattern: RHF field
// values use the input type, handleSubmit receives the validated output type.
type ExpenseInput = z.input<typeof expenseSchema>;
type ExpenseValues = z.output<typeof expenseSchema>;

export function ExpenseForm({
  expense,
  onDone,
}: {
  /** Present = edit mode; undefined = create mode. */
  expense?: Doc<"expenses">;
  /** Called after save or cancel — the page navigates back to the list. */
  onDone: () => void;
}) {
  const create = useMutation(api.expenses.create);
  const update = useMutation(api.expenses.update);
  const historicalCategories = useQuery(api.expenses.listCategories);
  const managedCategories = useQuery(api.expenseCategories.listActive);
  const [saving, setSaving] = useState(false);

  // Lazy initializer — Date.now() is impure, and lazy state initializers are
  // the sanctioned place for it. TContext is unused → `unknown`.
  const [now] = useState(() => Date.now());

  const form = useForm<ExpenseInput, unknown, ExpenseValues>({
    resolver: zodResolver(expenseSchema),
    defaultValues: {
      amount: expense ? (expense.amount / 100).toFixed(2) : "",
      category: expense?.category ?? "",
      spentAt: expense?.spentAt ?? now,
      note: expense?.note ?? "",
    },
  });

  const categoryOptions = new Map<string, string>();
  for (const category of managedCategories ?? []) {
    categoryOptions.set(category.nameLower, category.name);
  }
  for (const category of historicalCategories ?? []) {
    const key = category.toLowerCase();
    if (!categoryOptions.has(key)) categoryOptions.set(key, category);
  }
  if (expense && !categoryOptions.has(expense.categoryLower)) {
    categoryOptions.set(expense.categoryLower, expense.category);
  }

  async function onSubmit(values: ExpenseValues) {
    setSaving(true);
    try {
      const amount = inputToCents(values.amount);
      if (amount == null) {
        form.setError("amount", { message: t().products.invalidMoney });
        return;
      }
      const payload = {
        amount,
        category: values.category,
        spentAt: values.spentAt,
        note: values.note.trim() || undefined,
      };
      if (expense) {
        await update({ expenseId: expense._id, ...payload });
        toast.success(t().expenses.saved);
      } else {
        await create(payload);
        toast.success(t().expenses.created);
      }
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <Card>
          <CardHeader>
            <CardTitle>
              {expense ? t().expenses.editTitle : t().expenses.newTitle}
            </CardTitle>
            <CardDescription>{t().expenses.amountHint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormMoney
              name="amount"
              label={t().expenses.amount}
              required
              hint={t().expenses.amountHint}
            />
            <FormDate
              name="spentAt"
              label={t().expenses.date}
              required
              hint={t().expenses.dateHint}
            />
            <div className="sm:col-span-2">
              <FormCombobox
                name="category"
                label={t().expenses.category}
                required
                options={[...categoryOptions.values()].map((category) => ({
                  value: category,
                  label: category,
                }))}
                hint={t().expenses.categoryHint}
              />
              <QuickAddExpenseCategory
                onCreated={(category) => {
                  form.setValue("category", category, {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                }}
              />
            </div>
            <FormTextarea
              name="note"
              label={t().common.note}
              hint={t().expenses.noteHint}
              placeholder={t().expenses.noteHint}
              className="sm:col-span-2"
            />
          </CardContent>
          <CardFooter className="border-t">
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={saving}>
                {t().common.save}
              </Button>
              <Button type="button" variant="destructive" onClick={onDone}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
                {t().common.cancel}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </form>
    </FormProvider>
  );
}

function QuickAddExpenseCategory({ onCreated }: { onCreated: (name: string) => void }) {
  const createCategory = useMutation(api.expenseCategories.create);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const category = await createCategory({ name });
      onCreated(category.name);
      setName("");
      setOpen(false);
      toast.success(t().expenses.categoryCreated);
    } catch (error) {
      toastError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 h-11 w-full sm:h-9 sm:w-auto"
        onClick={() => setOpen(true)}
      >
        <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
        {t().expenses.newCategory}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t().expenses.newCategory}</DialogTitle>
            <DialogDescription>{t().expenses.newCategoryHint}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="new-expense-category">{t().expenses.category}</Label>
            <Input
              id="new-expense-category"
              value={name}
              maxLength={100}
              autoFocus
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" disabled={!name.trim() || saving} onClick={() => void save()}>
              {t().common.save}
            </Button>
            <Button type="button" variant="destructive" onClick={() => setOpen(false)}>
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
              {t().common.cancel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
