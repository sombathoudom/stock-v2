"use client";

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "convex/react";
import { Fragment, useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { centsToInput, inputToCents, t, toastError } from "@/lib/utils";

// Variant editor (edit page). Each row = one size × color combo; price/cost
// inputs show the EFFECTIVE value (placeholder = product default, typed value
// = override; the × clears back to default). Commit happens on blur.
//
// Bulk-apply covers every selection shape the spec asks for: whole product
// (Select all), one size across all colors (size group checkbox), one color
// across all sizes (color chips), or hand-picked combos (row checkboxes).

type Field = "price" | "cost" | "sku";

type Draft = { price: string; cost: string; sku: string };

export function VariantGrid({
  product,
  variants,
}: {
  product: Doc<"products">;
  variants: Doc<"productVariants">[];
}) {
  const updateVariant = useMutation(api.products.updateVariant);
  const bulkApply = useMutation(api.products.bulkApply);

  // Active rows in the product's own size/color order.
  const rows = useMemo(() => {
    const active = variants.filter((v) => v.active);
    const sizeIdx = (size: string) => Math.max(product.sizes.indexOf(size), 0);
    const colorIdx = (color: string | undefined) =>
      color === undefined ? -1 : Math.max(product.colors.indexOf(color), 0);
    return [...active].sort(
      (a, b) => sizeIdx(a.size) - sizeIdx(b.size) || colorIdx(a.color) - colorIdx(b.color)
    );
  }, [product, variants]);

  // What the user has typed, keyed by variant id. Missing entries seed from
  // the server doc on read (new/re-activated combos after a size/color edit).
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selected, setSelected] = useState<Set<Id<"productVariants">>>(new Set());
  const [bulkValue, setBulkValue] = useState("");
  const [busy, setBusy] = useState(false);

  function draftRow(id: string): Draft {
    return drafts[id] ?? { price: "", cost: "", sku: "" };
  }

  function draftOf(variant: Doc<"productVariants">): Draft {
    return (
      drafts[variant._id] ?? {
        price: centsToInput(variant.price ?? null),
        cost: centsToInput(variant.cost ?? null),
        sku: variant.sku ?? "",
      }
    );
  }

  function setDraftField(id: string, field: Field, value: string) {
    setDrafts((d) => ({ ...d, [id]: { ...draftRow(id), [field]: value } }));
  }

  /** Commit one field on blur. Server re-validates; errors revert the input. */
  async function commitField(variant: Doc<"productVariants">, field: Field) {
    const raw = draftOf(variant)[field].trim();
    if (field === "sku") {
      if ((variant.sku ?? "") === raw) return; // unchanged
      setBusy(true);
      try {
        await updateVariant({ variantId: variant._id, sku: raw || null });
      } catch (err) {
        setDraftField(variant._id, "sku", variant.sku ?? "");
        toastError(err);
      } finally {
        setBusy(false);
      }
      return;
    }
    // price / cost
    if (raw === "") {
      if (variant[field] == null) return; // already falling back
      setBusy(true);
      try {
        await updateVariant({ variantId: variant._id, [field]: null });
      } catch (err) {
        setDraftField(variant._id, field, centsToInput(variant[field] ?? null));
        toastError(err);
      } finally {
        setBusy(false);
      }
      return;
    }
    const cents = inputToCents(raw);
    if (cents === null) {
      // Invalid input — revert to the server value, show the friendly error.
      setDraftField(variant._id, field, centsToInput(variant[field] ?? null));
      toast.error(t().products.invalidMoney);
      return;
    }
    if (cents === variant[field]) return; // unchanged
    setBusy(true);
    try {
      await updateVariant({ variantId: variant._id, [field]: cents });
    } catch (err) {
      setDraftField(variant._id, field, centsToInput(variant[field] ?? null));
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  // The × button: clear the override directly (commitField would no-op on
  // an already-empty sku, so this path goes straight to the mutation).
  async function clearField(variant: Doc<"productVariants">, field: Field) {
    setDraftField(variant._id, field, "");
    setBusy(true);
    try {
      if (field === "sku") {
        await updateVariant({ variantId: variant._id, sku: null });
      } else {
        await updateVariant({ variantId: variant._id, [field]: null });
      }
    } catch (err) {
      setDraftField(
        variant._id,
        field,
        field === "sku" ? variant.sku ?? "" : centsToInput(variant[field] ?? null)
      );
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  // --- selection (bulk-apply) ---

  const allSelected = rows.length > 0 && rows.every((v) => selected.has(v._id));

  function toggleIds(ids: Id<"productVariants">[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const toggleAll = () => toggleIds(rows.map((v) => v._id), !allSelected);
  const toggleSize = (size: string) => {
    const ids = rows.filter((v) => v.size === size).map((v) => v._id);
    const on = !ids.every((id) => selected.has(id));
    toggleIds(ids, on);
  };
  const toggleColor = (color: string) => {
    const ids = rows.filter((v) => v.color === color).map((v) => v._id);
    const on = !ids.every((id) => selected.has(id));
    toggleIds(ids, on);
  };

  async function applyBulk(field: "price" | "cost") {
    const raw = bulkValue.trim();
    const cents = inputToCents(raw);
    if (cents === null) {
      toast.error(t().products.invalidMoney);
      return;
    }
    const ids = [...selected];
    setBusy(true);
    try {
      await bulkApply({ productId: product._id, variantIds: ids, field, value: cents });
      // Reflect the applied value in the inputs immediately.
      setDrafts((d) => {
        const next = { ...d };
        for (const id of ids) next[id] = { ...draftRow(id), [field]: raw };
        return next;
      });
      toast.success(t().products.applied);
      setSelected(new Set());
      setBulkValue("");
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function clearOverrides() {
    const ids = [...selected];
    setBusy(true);
    try {
      await bulkApply({ productId: product._id, variantIds: ids, field: "price", value: null });
      await bulkApply({ productId: product._id, variantIds: ids, field: "cost", value: null });
      setDrafts((d) => {
        const next = { ...d };
        for (const id of ids) next[id] = { ...draftRow(id), price: "", cost: "" };
        return next;
      });
      toast.success(t().products.applied);
      setSelected(new Set());
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  function moneyCell(variant: Doc<"productVariants">, field: "price" | "cost", aria: string) {
    const draft = draftOf(variant);
    return (
      <InputGroup className="w-32">
        <InputGroupInput
          value={draft[field]}
          placeholder={centsToInput(
            field === "price" ? product.defaultPrice : product.defaultCost
          )}
          inputMode="decimal"
          disabled={busy}
          aria-label={aria}
          onChange={(e) => setDraftField(variant._id, field, e.target.value)}
          onBlur={() => void commitField(variant, field)}
        />
        {variant[field] != null && (
          <InputGroupAddon>
            <button
              type="button"
              disabled={busy}
              aria-label={t().products.clearOverrides}
              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              onClick={() => clearField(variant, field)}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
            </button>
          </InputGroupAddon>
        )}
      </InputGroup>
    );
  }

  function skuCell(variant: Doc<"productVariants">) {
    const draft = draftOf(variant);
    return (
      <InputGroup className="w-32">
        <InputGroupInput
          value={draft.sku}
          placeholder="—"
          disabled={busy}
          aria-label={`${t().products.sku} ${variant.size}${variant.color ? ` ${variant.color}` : ""}`}
          onChange={(e) => setDraftField(variant._id, "sku", e.target.value)}
          onBlur={() => void commitField(variant, "sku")}
        />
        {variant.sku != null && (
          <InputGroupAddon>
            <button
              type="button"
              disabled={busy}
              aria-label={t().products.clearOverrides}
              className="text-muted-foreground hover:text-foreground disabled:opacity-50"
              onClick={() => clearField(variant, "sku")}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
            </button>
          </InputGroupAddon>
        )}
      </InputGroup>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t().products.variantsTitle}</CardTitle>
        <CardDescription>{t().products.variantsHint}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3">
            <span className="text-sm font-medium">
              {selected.size} {t().products.selectedCount}
            </span>
            <Input
              value={bulkValue}
              inputMode="decimal"
              placeholder="0.00"
              aria-label={t().products.applyTo}
              className="w-28"
              onChange={(e) => setBulkValue(e.target.value)}
            />
            <Button size="sm" disabled={busy} onClick={() => void applyBulk("price")}>
              {t().products.applyPrice}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void applyBulk("cost")}
            >
              {t().products.applyCost}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void clearOverrides()}
            >
              {t().products.clearOverrides}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setSelected(new Set())}
            >
              {t().products.clearSelection}
            </Button>
          </div>
        )}

        {product.hasColors && product.colors.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{t().products.colors}:</span>
            {product.colors.map((color) => {
              const ids = rows.filter((v) => v.color === color).map((v) => v._id);
              const on = ids.length > 0 && ids.every((id) => selected.has(id));
              return (
                <button
                  key={color}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleColor(color)}
                  className={
                    on
                      ? "inline-flex items-center rounded-full border border-primary bg-primary px-2.5 py-0.5 text-xs text-primary-foreground"
                      : "inline-flex items-center rounded-full border bg-background px-2.5 py-0.5 text-xs hover:bg-secondary"
                  }
                >
                  {color}
                </button>
              );
            })}
          </div>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allSelected}
                    onCheckedChange={() => toggleAll()}
                    aria-label={t().products.selectAll}
                  />
                </TableHead>
                <TableHead>{t().products.sizes}</TableHead>
                {product.hasColors && <TableHead>{t().products.colors}</TableHead>}
                <TableHead>{t().products.priceCol}</TableHead>
                <TableHead>{t().products.costCol}</TableHead>
                <TableHead>{t().products.sku}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((variant) => {
                const isFirstOfSize =
                  !product.hasColors || variant === rows.find((v) => v.size === variant.size);
                return (
                  <Fragment key={variant._id}>
                    {product.hasColors && isFirstOfSize && (
                      <TableRow className="bg-muted/40 hover:bg-muted/40">
                        <TableCell>
                          <Checkbox
                            checked={rows
                              .filter((v) => v.size === variant.size)
                              .every((v) => selected.has(v._id))}
                            onCheckedChange={() => toggleSize(variant.size)}
                            aria-label={`${t().products.selectAll} ${variant.size}`}
                          />
                        </TableCell>
                        <TableCell colSpan={5} className="font-medium">
                          {variant.size}
                        </TableCell>
                      </TableRow>
                    )}
                    <TableRow>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(variant._id)}
                          onCheckedChange={() =>
                            toggleIds([variant._id], !selected.has(variant._id))
                          }
                          aria-label={`${variant.size}${variant.color ? ` ${variant.color}` : ""}`}
                        />
                      </TableCell>
                      {!product.hasColors && <TableCell>{variant.size}</TableCell>}
                      {product.hasColors && (
                        <TableCell className="text-muted-foreground">{variant.color}</TableCell>
                      )}
                      <TableCell>
                        {moneyCell(
                          variant,
                          "price",
                          `${t().products.priceCol} ${variant.size}${variant.color ? ` ${variant.color}` : ""}`
                        )}
                      </TableCell>
                      <TableCell>
                        {moneyCell(
                          variant,
                          "cost",
                          `${t().products.costCol} ${variant.size}${variant.color ? ` ${variant.color}` : ""}`
                        )}
                      </TableCell>
                      <TableCell>{skuCell(variant)}</TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
