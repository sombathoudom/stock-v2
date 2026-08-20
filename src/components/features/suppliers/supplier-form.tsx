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
import { useCurrentUser } from "@/hooks/use-current-user";
import { t, toastError } from "@/lib/utils";

// One shared form for the create and edit supplier pages. The server
// re-validates everything (convex/suppliers.ts) — this is UX validation.

const supplierSchema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  phone: z.string().trim().max(50),
  notes: z.string().max(2000),
  active: z.boolean(),
});

type SupplierValues = z.infer<typeof supplierSchema>;

export function SupplierForm({
  supplier,
  onDone,
}: {
  /** Present = edit mode; undefined = create mode. */
  supplier?: Doc<"suppliers">;
  /** Called after save or cancel — the page navigates back to the list. */
  onDone: () => void;
}) {
  const create = useMutation(api.suppliers.create);
  const update = useMutation(api.suppliers.update);
  const [saving, setSaving] = useState(false);
  const user = useCurrentUser();

  const form = useForm<SupplierValues>({
    resolver: zodResolver(supplierSchema),
    defaultValues: {
      name: supplier?.name ?? "",
      phone: supplier?.phone ?? "",
      notes: supplier?.notes ?? "",
      active: supplier?.active ?? true,
    },
  });

  async function onSubmit(values: SupplierValues) {
    setSaving(true);
    try {
      const payload = {
        name: values.name,
        phone: values.phone.trim() || undefined,
        notes: values.notes.trim() || undefined,
      };
      if (supplier) {
        await update({ supplierId: supplier._id, ...payload, active: values.active });
        toast.success(t().suppliers.saved);
      } else {
        await create(payload);
        toast.success(t().suppliers.created);
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
              {supplier ? t().suppliers.editTitle : t().suppliers.newTitle}
            </CardTitle>
            <CardDescription>{t().suppliers.nameHint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormInput
              name="name"
              label={t().common.name}
              required
              maxLength={100}
              placeholder={t().suppliers.nameHint}
            />
            <FormInput
              name="phone"
              label={t().suppliers.phone}
              hint={t().suppliers.phoneHint}
              maxLength={50}
              inputMode="tel"
              placeholder="012 345 678"
            />
            <FormTextarea
              name="notes"
              label={t().suppliers.notes}
              hint={t().suppliers.notesHint}
              placeholder={t().suppliers.notesHint}
            />
            {/* Deactivating is owner-only — staff see no switch (the form
                keeps the record's current value, so saves still work). */}
            {(user == null || user.role === "owner") && (
              <FormSwitch
                name="active"
                label={t().common.active}
                hint={t().suppliers.activeHint}
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
