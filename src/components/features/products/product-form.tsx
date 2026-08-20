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
import { FormCombobox } from "@/components/features/forms/form-combobox";
import { FormInput } from "@/components/features/forms/form-input";
import { FormMoney, moneyInputSchema } from "@/components/features/forms/form-money";
import { FormSwitch } from "@/components/features/forms/form-switch";
import { FormTagInput } from "@/components/features/forms/form-tag-input";
import { FormTextarea } from "@/components/features/forms/form-textarea";
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
import { inputToCents, t, toastError } from "@/lib/utils";

// One shared form for the create and edit product pages. Sizes/colors live
// on the product; the server creates/syncs variant rows. Money fields hold
// decimal strings here and become integer cents only at submit — the server
// re-validates everything.

const tagSchema = z.array(z.string().min(1)).min(1, "Required").max(30);

const productSchema = z
  .object({
    name: z.string().trim().min(1, "Required").max(100),
    // The shop's own product code (one per product; SKUs identify variants).
    code: z.string().trim().max(50),
    description: z.string().max(2000),
    categoryId: z.string(), // "" = none
    hasColors: z.boolean(),
    sizes: tagSchema,
    colors: z.array(z.string()).max(30),
    defaultPrice: moneyInputSchema,
    defaultCost: moneyInputSchema,
    imageStorageId: z.string().optional(),
    active: z.boolean(),
  })
  .superRefine((values, ctx) => {
    if (values.hasColors && values.colors.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["colors"],
        message: "Required",
      });
    }
  });

type ProductValues = z.infer<typeof productSchema>;

export function ProductForm({
  product,
  categories,
  onDone,
}: {
  /** Present = edit mode; undefined = create mode. */
  product?: Doc<"products">;
  /** All categories (the page passes its own query result). */
  categories: Doc<"categories">[];
  /** Called after save or cancel — the page navigates back to the list. */
  onDone: () => void;
}) {
  const create = useMutation(api.products.create);
  const update = useMutation(api.products.update);
  const [saving, setSaving] = useState(false);
  const user = useCurrentUser();

  const form = useForm<ProductValues>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: product?.name ?? "",
      code: product?.code ?? "",
      description: product?.description ?? "",
      categoryId: product?.categoryId ?? "",
      hasColors: product?.hasColors ?? false,
      sizes: product?.sizes ?? [],
      colors: product?.colors ?? [],
      defaultPrice: product ? String((product.defaultPrice / 100).toFixed(2)) : "",
      defaultCost: product ? String((product.defaultCost / 100).toFixed(2)) : "",
      imageStorageId: product?.imageStorageId,
      active: product?.active ?? true,
    },
  });

  const hasColors = form.watch("hasColors");
  const activeCategories = categories.filter((c) => c.active);

  async function onSubmit(values: ProductValues) {
    setSaving(true);
    try {
      const payload = {
        name: values.name,
        code: values.code.trim() || undefined,
        description: values.description.trim() || undefined,
        // The combobox stores ids as strings; re-tag them at the wire edge.
        categoryId: values.categoryId
          ? (values.categoryId as Id<"categories">)
          : undefined,
        defaultPrice: inputToCents(values.defaultPrice)!,
        defaultCost: inputToCents(values.defaultCost)!,
        hasColors: values.hasColors,
        sizes: values.sizes,
        colors: values.hasColors ? values.colors : [],
        imageStorageId: values.imageStorageId as Id<"_storage"> | undefined,
      };
      if (product) {
        await update({ productId: product._id, ...payload, active: values.active });
        toast.success(t().products.saved);
      } else {
        await create(payload);
        toast.success(t().products.created);
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
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>{product ? t().products.editTitle : t().products.newTitle}</CardTitle>
            <CardDescription>{t().products.nameHint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormInput
              name="name"
              label={t().common.name}
              required
              maxLength={100}
              placeholder={t().products.nameHint}
            />
            <FormInput
              name="code"
              label={t().products.code}
              hint={t().products.codeHint}
              maxLength={50}
            />
            <FormCombobox
              name="categoryId"
              label={t().products.category}
              hint={t().products.categoryHint}
              options={[
                { value: "", label: t().products.allCategories },
                ...activeCategories.map((c) => ({ value: c._id, label: c.name })),
              ]}
            />
            <FormTextarea
              name="description"
              label={t().products.description}
              hint={t().products.descriptionHint}
              placeholder={t().products.descriptionHint}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t().products.photo}</CardTitle>
            <CardDescription>{t().products.photoHint}</CardDescription>
          </CardHeader>
          <CardContent>
            <ImageUpload name="imageStorageId" label={t().products.photo} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t().products.defaultPrice}</CardTitle>
            <CardDescription>{t().products.defaultPriceHint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <FormMoney
              name="defaultPrice"
              label={t().products.defaultPrice}
              required
              hint={t().products.defaultPriceHint}
            />
            <FormMoney
              name="defaultCost"
              label={t().products.defaultCost}
              required
              hint={t().products.defaultCostHint}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              {t().products.sizes}
              {hasColors ? ` × ${t().products.colors}` : ""}
            </CardTitle>
            <CardDescription>
              {product ? t().products.variantsSyncHint : t().products.hasColorsHint}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormSwitch
              name="hasColors"
              label={t().products.hasColors}
              hint={t().products.hasColorsHint}
            />
            <FormTagInput
              name="sizes"
              label={t().products.sizes}
              required
              hint={t().products.sizesHint}
              placeholder={t().products.sizesHint}
            />
            {hasColors && (
              <FormTagInput
                name="colors"
                label={t().products.colors}
                required
                hint={t().products.colorsHint}
                placeholder={t().products.colorsHint}
              />
            )}
          </CardContent>
        </Card>

        {/* Deactivating is owner-only — staff see no switch (the form keeps
            the record's current value, so saves still work). */}
        {product && (user == null || user.role === "owner") && (
          <Card>
            <CardContent className="pt-6">
              <FormSwitch
                name="active"
                label={t().common.active}
                hint={t().products.activeHint}
              />
            </CardContent>
          </Card>
        )}

        <Card>
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
