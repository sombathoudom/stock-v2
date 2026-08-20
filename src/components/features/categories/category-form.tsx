"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "convex/react";
import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import { FormInput } from "@/components/features/forms/form-input";
import { FormSwitch } from "@/components/features/forms/form-switch";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCurrentUser } from "@/hooks/use-current-user";
import { t, toastError } from "@/lib/utils";

// One shared form for the create and edit category pages. The server
// re-validates everything (convex/categories.ts) — this is UX validation.

const categorySchema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  active: z.boolean(),
});

type CategoryValues = z.infer<typeof categorySchema>;

export function CategoryForm({
  category,
  onDone,
}: {
  /** Present = edit mode; undefined = create mode. */
  category?: Doc<"categories">;
  /** Called after save or cancel — the page navigates back to the list. */
  onDone: () => void;
}) {
  const create = useMutation(api.categories.create);
  const update = useMutation(api.categories.update);
  const [saving, setSaving] = useState(false);
  const user = useCurrentUser();

  const form = useForm<CategoryValues>({
    resolver: zodResolver(categorySchema),
    defaultValues: {
      name: category?.name ?? "",
      active: category?.active ?? true,
    },
  });

  async function onSubmit(values: CategoryValues) {
    setSaving(true);
    try {
      if (category) {
        await update({ categoryId: category._id, ...values });
        toast.success(t().categories.saved);
      } else {
        await create({ name: values.name });
        toast.success(t().categories.created);
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
              {category ? t().categories.editTitle : t().categories.newTitle}
            </CardTitle>
            <CardDescription>{t().categories.nameHint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormInput
              name="name"
              label={t().common.name}
              required
              maxLength={100}
              placeholder={t().categories.nameHint}
            />
            {/* Deactivating is owner-only — staff see no switch (the form
                keeps the record's current value, so saves still work). */}
            {(user == null || user.role === "owner") && (
              <FormSwitch
                name="active"
                label={t().common.active}
                hint={t().categories.activeHint}
              />
            )}
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
