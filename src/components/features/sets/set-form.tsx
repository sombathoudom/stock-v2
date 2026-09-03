"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Cancel01Icon, Delete02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { FormProvider, useFieldArray, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { FormCombobox } from "@/components/features/forms/form-combobox";
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
import { centsToInput, formatMoney, getLang, inputToCents, t, toastError } from "@/lib/utils";

// Combo set create/edit form. A set is a recipe of existing products, each
// with a qty and a "set price" (the price per piece inside the set — the
// product's normal price is untouched). Server re-validates everything.

const setSchema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  imageStorageId: z.string().optional(),
  active: z.boolean(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1, "Required"),
        qty: z.coerce.number().int().min(1).max(1_000_000),
        setPrice: moneyInputSchema,
      }),
    )
    .min(1, "Add at least one item"),
});

type SetFormInput = z.input<typeof setSchema>;
type SetFormValues = z.output<typeof setSchema>;

/** A set detail as returned by api.sets.get (set + joined component items). */
type SetDetail = {
  set: Doc<"sets">;
  items: { item: Doc<"setItems">; product: Doc<"products"> }[];
  setTotal: number;
};

export function SetForm({
  detail,
  onDone,
}: {
  /** Present = edit mode; undefined = create mode. */
  detail?: SetDetail;
  onDone: () => void;
}) {
  const create = useMutation(api.sets.create);
  const update = useMutation(api.sets.update);
  const productsResult = useQuery(api.products.listAllActive, {});
  const [saving, setSaving] = useState(false);
  const user = useCurrentUser();
  const lang = getLang();

  const currency = (useQuery(api.shop.get, {})?.currency) ?? "USD";

  const form = useForm<SetFormInput, unknown, SetFormValues>({
    resolver: zodResolver(setSchema),
    defaultValues: {
      name: detail?.set.name ?? "",
      imageStorageId: detail?.set.imageStorageId,
      active: detail?.set.active ?? true,
      items:
        detail?.items.map((row) => ({
          productId: row.item.productId,
          qty: row.item.qty,
          setPrice: centsToInput(row.item.setPrice),
        })) ?? [{ productId: "", qty: 1, setPrice: "" }],
    },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "items",
  });

  const productOptions = useMemo(
    () => (productsResult ?? []).map((p) => ({ value: p._id, label: p.name })),
    [productsResult],
  );

  // Live set total (display only; the server recomputes from the recipe).
  const watchedItems = form.watch("items");
  const setTotal = useMemo(() => {
    let total = 0;
    for (const item of watchedItems ?? []) {
      const price = inputToCents(item.setPrice ?? "") ?? 0;
      const qty = Number(item.qty) || 0;
      total += price * qty;
    }
    return total;
  }, [watchedItems]);

  async function onSubmit(values: SetFormValues) {
    setSaving(true);
    try {
      const payload = {
        name: values.name,
        imageStorageId: values.imageStorageId as Id<"_storage"> | undefined,
        items: values.items.map((item) => ({
          productId: item.productId as Id<"products">,
          qty: item.qty,
          setPrice: inputToCents(item.setPrice) ?? 0,
        })),
      };
      if (detail) {
        await update({ setId: detail.set._id, ...payload, active: values.active });
        toast.success(t().sets.saved);
      } else {
        await create(payload);
        toast.success(t().sets.created);
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
      <form onSubmit={form.handleSubmit((values) => void onSubmit(values))}>
        <Card>
          <CardHeader>
            <CardTitle>{detail ? t().sets.editTitle : t().sets.newTitle}</CardTitle>
            <CardDescription>{t().sets.nameHint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormInput
              name="name"
              label={t().common.name}
              required
              maxLength={100}
              placeholder={t().sets.nameHint}
            />
            <ImageUpload name="imageStorageId" label={t().sets.photo} hint={t().sets.photoHint} />

            {/* Component rows: product + qty + set price. */}
            <div className="grid gap-3">
              <p className="text-sm font-medium">{t().sets.components}</p>
              {fields.map((row, index) => (
                <div
                  key={row.id}
                  className="grid items-end gap-2 rounded-md border p-2 sm:grid-cols-[1fr_5rem_8rem_auto]"
                >
                  <FormCombobox
                    name={`items.${index}.productId`}
                    label={t().sets.product}
                    options={productOptions}
                    placeholder={t().sets.productHint}
                    required
                  />
                  <FormInput
                    name={`items.${index}.qty`}
                    label={t().sets.qty}
                    type="number"
                    inputMode="numeric"
                    min={1}
                  />
                  <FormMoney
                    name={`items.${index}.setPrice`}
                    label={`${t().sets.setPrice} (${currency})`}
                    placeholder="0.00"
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    className="mb-0.5"
                    aria-label={t().common.delete}
                    disabled={fields.length <= 1}
                    onClick={() => remove(index)}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                onClick={() => append({ productId: "", qty: 1, setPrice: "" })}
              >
                <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
                {t().sets.addComponent}
              </Button>
            </div>

            {/* Live set total. */}
            <div className="flex items-center justify-between border-t pt-3 text-sm font-semibold">
              <span>{t().sets.setTotal}</span>
              <span className="tabular-nums">{formatMoney(setTotal, currency, lang)}</span>
            </div>

            {/* Deactivating is owner-only. */}
            {(user == null || user.role === "owner") && (
              <FormSwitch name="active" label={t().common.active} hint={t().sets.activeHint} />
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
