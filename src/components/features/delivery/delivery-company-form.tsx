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
import type { Doc, Id } from "@convex/_generated/dataModel";
import { FormInput } from "@/components/features/forms/form-input";
import { FormMoney, moneyInputSchema } from "@/components/features/forms/form-money";
import { FormSwitch } from "@/components/features/forms/form-switch";
import { ImageUpload } from "@/components/features/products/image-upload";
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
import { centsToInput, inputToCents, t, toastError } from "@/lib/utils";

// One shared form for the create and edit delivery-company pages (T9).
// The server re-validates everything (convex/delivery-companies.ts) — this
// is UX validation. defaultFee = what the SHOP pays per handled order.

const deliveryCompanySchema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  phone: z.string().trim().max(50),
  defaultFee: moneyInputSchema,
  imageStorageId: z.string().optional(),
  active: z.boolean(),
});

type DeliveryCompanyValues = z.infer<typeof deliveryCompanySchema>;

export function DeliveryCompanyForm({
  company,
  onDone,
}: {
  /** Present = edit mode; undefined = create mode. */
  company?: Doc<"deliveryCompanies">;
  /** Called after save or cancel — the page navigates back to the list. */
  onDone: () => void;
}) {
  const create = useMutation(api.deliveryCompanies.create);
  const update = useMutation(api.deliveryCompanies.update);
  const [saving, setSaving] = useState(false);
  const user = useCurrentUser();

  const form = useForm<DeliveryCompanyValues>({
    resolver: zodResolver(deliveryCompanySchema),
    defaultValues: {
      name: company?.name ?? "",
      phone: company?.phone ?? "",
      defaultFee: centsToInput(company?.defaultFee ?? 0),
      imageStorageId: company?.imageStorageId,
      active: company?.active ?? true,
    },
  });

  async function onSubmit(values: DeliveryCompanyValues) {
    setSaving(true);
    try {
      const payload = {
        name: values.name,
        phone: values.phone.trim() || undefined,
        defaultFee: inputToCents(values.defaultFee) ?? 0,
        imageStorageId: values.imageStorageId as Id<"_storage"> | undefined,
      };
      if (company) {
        await update({ companyId: company._id, ...payload, active: values.active });
        toast.success(t().deliveryCompanies.saved);
      } else {
        await create(payload);
        toast.success(t().deliveryCompanies.created);
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
              {company ? t().deliveryCompanies.editTitle : t().deliveryCompanies.newTitle}
            </CardTitle>
            <CardDescription>{t().deliveryCompanies.nameHint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormInput
              name="name"
              label={t().common.name}
              required
              maxLength={100}
              placeholder={t().deliveryCompanies.nameHint}
            />
            <FormInput
              name="phone"
              label={t().deliveryCompanies.phone}
              maxLength={50}
              hint={t().deliveryCompanies.phoneHint}
              placeholder="010 000 000"
            />
            <FormMoney
              name="defaultFee"
              label={t().deliveryCompanies.defaultFee}
              required
              hint={t().deliveryCompanies.defaultFeeHint}
            />
            <ImageUpload
              name="imageStorageId"
              label={t().deliveryCompanies.logo}
              hint={t().deliveryCompanies.logoHint}
            />
            {/* Deactivating is owner-only — staff see no switch (the form
                keeps the record's current value, so saves still work). */}
            {(user == null || user.role === "owner") && (
              <FormSwitch
                name="active"
                label={t().common.active}
                hint={t().deliveryCompanies.activeHint}
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
