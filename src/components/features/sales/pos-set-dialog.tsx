"use client";

import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex/react";
import { useMemo, useState } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { CartLine } from "@/hooks/use-checkout-cart";
import { formatMoney, getLang, t } from "@/lib/utils";

// Combo-set size popup (Option 2). Tapping a set card opens this: one size
// picker per component UNIT (a "2 pants" set shows two pants rows, so mix-and-
// match is possible), then "Add set to cart" adds each chosen variant as a
// normal cart line carrying the set price + a shared setGroupId. The server
// re-reads the set price from the recipe at checkout — the price shown here
// is display only.

type SetDetail = FunctionReturnType<typeof api.sets.listActive>[number];
type PosProduct = FunctionReturnType<typeof api.pos.getVariantsForProducts>[number];

/** One row in the popup: a single unit of a component that needs a size. */
type Slot = {
  slotKey: string; // stable per unit
  productId: string;
  productName: string;
  setPrice: number; // per-piece set price (display)
};

export function PosSetDialog({
  detail,
  currency,
  onClose,
  onAdd,
}: {
  /** Null = closed. */
  detail: SetDetail | null;
  currency: string;
  onClose: () => void;
  /** Add the resolved component lines (one per unit) to the cart. */
  onAdd: (lines: Omit<CartLine, "key">[], setGroupId: string) => void;
}) {
  const open = detail !== null;

  // Expand each component into one slot per unit (qty).
  const slots = useMemo<Slot[]>(() => {
    if (!detail) return [];
    const out: Slot[] = [];
    for (const { item, product } of detail.items) {
      for (let i = 0; i < item.qty; i++) {
        out.push({
          slotKey: `${item._id}-${i}`,
          productId: item.productId,
          productName: product.name,
          setPrice: item.setPrice,
        });
      }
    }
    return out;
  }, [detail]);

  // The chosen variant per slot.
  const [chosen, setChosen] = useState<Record<string, string>>({});

  // Load active variants + stock for the component products in one batch.
  const productIds = useMemo(
    () => (detail ? [...new Set(detail.items.map((r) => r.item.productId))] : []),
    [detail],
  );
  const variantData = useQuery(
    api.pos.getVariantsForProducts,
    detail ? { productIds: productIds as Id<"products">[] } : "skip",
  );
  const byProduct = useMemo(() => {
    const map = new Map<string, PosProduct>();
    for (const entry of variantData ?? []) map.set(entry.product._id, entry);
    return map;
  }, [variantData]);

  const setTotal = detail?.setTotal ?? 0;
  const allChosen = slots.length > 0 && slots.every((s) => chosen[s.slotKey]);

  function reset() {
    setChosen({});
  }

  function confirm() {
    if (!detail || !allChosen) return;
    const setGroupId = crypto.randomUUID();
    const lines: Omit<CartLine, "key">[] = [];
    for (const slot of slots) {
      const variantId = chosen[slot.slotKey];
      const entry = byProduct.get(slot.productId);
      const info = entry?.variants.find((v) => v.variant._id === variantId);
      if (!info) return; // shouldn't happen — button is disabled until all chosen
      const label = `${slot.productName} / ${info.variant.size}${
        info.variant.color ? ` · ${info.variant.color}` : ""
      }`;
      lines.push({
        variantId,
        label,
        price: slot.setPrice, // display only; server re-derives from recipe
        qty: 1,
        discount: "",
        stock: info.stock,
        imageStorageId: entry?.product.imageStorageId,
        setId: detail.set._id,
        setGroupId,
        setName: detail.set.name,
      });
    }
    onAdd(lines, setGroupId);
    reset();
    onClose();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{detail?.set.name ?? t().sets.pickSizes}</DialogTitle>
          <DialogDescription>{t().sets.pickSizesHint}</DialogDescription>
        </DialogHeader>

        {detail === null ? null : variantData === undefined ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="flex flex-col gap-3">
            {slots.map((slot) => {
              const entry = byProduct.get(slot.productId);
              const variants = entry?.variants ?? [];
              return (
                <div key={slot.slotKey} className="grid gap-1.5">
                  <Label className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">{slot.productName}</span>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatMoney(slot.setPrice, currency, getLang())}
                    </span>
                  </Label>
                  <Select
                    value={chosen[slot.slotKey] ?? null}
                    items={Object.fromEntries(
                      variants.map((v) => [
                        v.variant._id,
                        `${v.variant.size}${v.variant.color ? ` · ${v.variant.color}` : ""}`,
                      ]),
                    )}
                    onValueChange={(value) =>
                      setChosen((prev) => ({ ...prev, [slot.slotKey]: value as string }))
                    }
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder={t().sets.pickSizes} />
                    </SelectTrigger>
                    <SelectContent>
                      {variants.map((v) => {
                        const outOfStock = v.stock <= 0;
                        return (
                          <SelectItem
                            key={v.variant._id}
                            value={v.variant._id}
                            disabled={outOfStock}
                          >
                            {v.variant.size}
                            {v.variant.color ? ` · ${v.variant.color}` : ""}
                            {outOfStock ? ` — ${t().sets.outOfStock}` : ""}
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}

            <div className="flex items-center justify-between border-t pt-3 text-sm font-semibold">
              <span>{t().sets.setTotal}</span>
              <span className="tabular-nums">{formatMoney(setTotal, currency, getLang())}</span>
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-end">
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
            {t().common.cancel}
          </Button>
          <Button type="button" disabled={!allChosen} onClick={confirm}>
            <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" />
            {t().sets.addToCart}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
