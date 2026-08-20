"use client";

import { Delete02Icon, Image01Icon, Undo02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrentUser } from "@/hooks/use-current-user";
import { cn, formatMoney, imageUrl, inputToCents, t } from "@/lib/utils";

// The editable items table for the full-page order editor. Everything here is
// LOCAL state — no quantity moves in stock until the page is saved, which is
// the whole reason this screen exists. Row maths mirror the server exactly
// (integer cents, subtotal = qty × price − discount), but the server re-derives
// all of it on save; these numbers are for the person typing, nothing more.

export type EditLine = {
  /** Stable react key. Existing lines use their saleItemId. */
  key: string;
  /** Absent = a line that doesn't exist in the database yet. */
  saleItemId?: Id<"saleItems">;
  variantId: Id<"productVariants">;
  productName: string;
  variantLabel: string;
  sku?: string;
  /** Product photo, when the product has one (Convex file storage). */
  imageStorageId?: string;
  /** Raw input text — parsed on every render so typing never fights the state. */
  qty: string;
  price: string;
  discount: string;
  /** What the line looked like at load, for the "changed?" check. */
  originalQty: number;
  originalPrice: number;
  originalDiscount: number;
  /** Pieces ever handed to the customer (historical — invariant 5). */
  qtyDelivered: number;
  /** Pieces that came back. The floor this line can't go under is the
   * derived difference (invariant 6): delivered − returned. */
  qtyReturned: number;
  /** Highest this line can be raised to: its own billed pieces + shelf stock. */
  maxQty: number;
  /** Marked for removal — applied (and returned to stock) on save. */
  removed: boolean;
};

/** Product photo thumbnail — the product's picture when it has one, a muted
 * image placeholder when it doesn't. Same pattern as the POS grid. */
function Thumb({ imageStorageId, className }: { imageStorageId?: string; className?: string }) {
  if (imageStorageId) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl(imageStorageId)}
        alt=""
        className={cn("shrink-0 rounded-sm border object-cover", className)}
      />
    );
  }
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-sm border bg-muted text-muted-foreground",
        className
      )}
    >
      <HugeiconsIcon icon={Image01Icon} strokeWidth={2} className="size-3.5" />
    </span>
  );
}

/** Parsed quantity, or null when what's typed isn't a whole number. */
export function lineQty(line: EditLine): number | null {
  const raw = line.qty.trim();
  if (!/^\d{1,6}$/.test(raw)) return null;
  return Number(raw);
}

export function linePrice(line: EditLine): number | null {
  return inputToCents(line.price);
}

/** Parsed item discount; an empty box means no discount, not an error. */
export function lineDiscount(line: EditLine): number | null {
  if (line.discount.trim() === "") return 0;
  return inputToCents(line.discount);
}

export function lineSubtotal(line: EditLine): number {
  if (line.removed) return 0;
  const qty = lineQty(line);
  const price = linePrice(line);
  const discount = lineDiscount(line);
  if (qty == null || price == null || discount == null) return 0;
  return Math.max(0, qty * price - discount);
}

/**
 * What's wrong with this row, in shop language — or null when it's fine.
 * Client-side only: it stops a doomed save early and points at the row, but
 * the server checks all of it again and is the one that decides.
 */
export function lineError(line: EditLine): string | null {
  if (line.removed) return null;
  const labels = t().sales.edit;
  const qty = lineQty(line);
  if (qty == null || qty < 1) return labels.invalidQty;
  // The floor is what the customer currently holds — the historical
  // delivered count minus what already came back (the server checks the
  // same derived bound before applying the diff).
  const held = line.qtyDelivered - line.qtyReturned;
  if (qty < held) {
    return labels.belowHeld.replace("{qty}", String(held));
  }
  if (qty > line.maxQty) {
    return labels.notEnoughStock.replace("{qty}", String(line.maxQty));
  }
  const price = linePrice(line);
  if (price == null) return labels.priceRequired;
  const discount = lineDiscount(line);
  if (discount == null) return labels.priceRequired;
  if (discount > qty * price) return labels.discountTooBig;
  return null;
}

/** Has this line changed at all? Drives the unsaved-changes guard. */
export function lineChanged(line: EditLine): boolean {
  if (line.saleItemId === undefined) return true; // a new line is a change
  // A removed line bills nothing. Comparing that against what the line billed
  // at load means a row that ALREADY billed nothing — cancelled or returned
  // long before this page opened — reads as untouched, not as an edit.
  const qty = line.removed ? 0 : lineQty(line);
  return (
    qty !== line.originalQty ||
    linePrice(line) !== line.originalPrice ||
    lineDiscount(line) !== line.originalDiscount
  );
}

export function SaleEditItemsTable({
  lines,
  onChange,
  currency,
  disabled,
}: {
  lines: EditLine[];
  onChange: (next: EditLine[]) => void;
  currency: string;
  disabled: boolean;
}) {
  const user = useCurrentUser();
  const labels = t().sales.edit;

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  // Bumped after every pick so the combobox remounts empty and is ready for
  // the next item instead of holding the one just added.
  const [pickerKey, setPickerKey] = useState(0);
  const [pendingRemove, setPendingRemove] = useState<EditLine | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const results = useQuery(
    api.pos.searchVariants,
    user == null ? "skip" : { search: debounced.trim() || undefined }
  );

  const resultById = useMemo(
    () => new Map((results ?? []).map((r) => [r.variantId as string, r])),
    [results]
  );

  function patchLine(key: string, patch: Partial<EditLine>) {
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  /** Picking an item adds a new row. The same item picked twice stays two
   * separate lines — exactly like checkout, the server never merges them
   * (each line is billed and stocked on its own). */
  function addVariant(variantId: string) {
    const found = resultById.get(variantId);
    if (!found) return;
    if (found.stock < 1) {
      toast.error(labels.notEnoughStock.replace("{qty}", "0"));
      return;
    }
    onChange([
      ...lines,
      {
        key: `new-${crypto.randomUUID()}`,
        variantId: found.variantId,
        productName: found.productName,
        variantLabel: found.label,
        sku: found.sku,
        imageStorageId: found.imageStorageId,
        qty: "1",
        // Seeded from the shop's current price; the server re-derives it when
        // the box is left untouched and re-validates it when it isn't.
        price: (found.price / 100).toFixed(2),
        discount: "",
        originalQty: 0,
        originalPrice: found.price,
        originalDiscount: 0,
        qtyReturned: 0,
        qtyDelivered: 0,
        maxQty: found.stock,
        removed: false,
      },
    ]);
  }

  /** A row the user asked to drop. New rows just disappear (nothing of them
   * exists yet); saved rows are marked and confirmed, because removing one
   * moves real stock when the page is saved. */
  function requestRemove(line: EditLine) {
    if (line.saleItemId === undefined) {
      onChange(lines.filter((l) => l.key !== line.key));
      return;
    }
    setPendingRemove(line);
  }

  /** Put a removed row back on the bill. A row that was already billing
   * nothing when the page opened comes back at one piece — restoring it to
   * zero would just be an invalid row the user has to fix. */
  function restoreLine(line: EditLine) {
    const qty = lineQty(line);
    patchLine(line.key, {
      removed: false,
      ...(qty == null || qty < 1 ? { qty: "1" } : {}),
    });
  }

  const itemsSubtotal = lines.reduce((sum, l) => sum + lineSubtotal(l), 0);

  return (
    <div className="flex flex-col gap-4">
      {/* The add-item picker sits above the table (searchable by name or SKU). */}
      <div className="grid gap-2">
        <Label htmlFor="sale-edit-add-item">{labels.addItem}</Label>
        <Combobox
          key={pickerKey}
          items={(results ?? []).map((r) => r.variantId as string)}
          itemToStringLabel={(item) => {
            if (item == null) return "";
            const value =
              typeof item === "object" && "value" in item
                ? String((item as { value: unknown }).value)
                : String(item);
            const found = resultById.get(value);
            return found ? `${found.productName} — ${found.label}` : "";
          }}
          value={null}
          onValueChange={(value) => {
            if (typeof value === "string" && value) {
              addVariant(value);
              setQuery("");
              setPickerKey((n) => n + 1);
            }
          }}
          onInputValueChange={(inputValue, eventDetails) => {
            if (eventDetails?.reason === "input-change") setQuery(inputValue);
          }}
          disabled={disabled}
        >
          <ComboboxInput
            id="sale-edit-add-item"
            placeholder={labels.addItemPlaceholder}
            showClear
          />
          <ComboboxContent>
            <ComboboxEmpty>{labels.noMatches}</ComboboxEmpty>
            <ComboboxList>
              {(results ?? []).map((r) => (
                <ComboboxItem key={r.variantId} value={r.variantId as string}>
                  <Thumb
                    imageStorageId={r.imageStorageId}
                    className="size-8 min-w-8"
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{r.productName}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {r.label}
                      {r.sku ? ` · ${r.sku}` : ""} · {r.stock} {t().sales.inStock}
                    </span>
                  </span>
                </ComboboxItem>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>

      {/* Desktop table — the phone gets the card list below (same data). */}
      <div className="hidden rounded-md border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labels.colItem}</TableHead>
              <TableHead>{labels.colVariant}</TableHead>
              <TableHead className="w-28 text-right">{labels.colPrice}</TableHead>
              <TableHead className="w-24 text-right">{labels.colStock}</TableHead>
              <TableHead className="w-24 text-right">{labels.colQty}</TableHead>
              <TableHead className="w-28 text-right">{labels.colDiscount}</TableHead>
              <TableHead className="w-28 text-right">{labels.colSubtotal}</TableHead>
              <TableHead className="w-16 text-right">{labels.colAction}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lines.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground">
                  {labels.emptyItems}
                </TableCell>
              </TableRow>
            ) : (
              lines.map((line) => {
                const error = lineError(line);
                const qty = lineQty(line) ?? 0;
                const left = Math.max(0, line.maxQty - qty);
                return (
                  <TableRow
                    key={line.key}
                    className={cn(line.removed && "opacity-50")}
                  >
                    <TableCell className="font-medium">
                      <div className="flex flex-col">
                        <span className="flex items-center gap-2">
                          <Thumb
                            imageStorageId={line.imageStorageId}
                            className="size-7 min-w-7"
                          />
                          <span
                            className={cn("truncate", line.removed && "line-through")}
                          >
                            {line.productName}
                          </span>
                          {line.saleItemId === undefined && !line.removed ? (
                            <Badge variant="info">{labels.newLine}</Badge>
                          ) : null}
                          {line.removed ? (
                            <Badge variant="destructive">{labels.removed}</Badge>
                          ) : null}
                        </span>
                        {/* Row errors sit under the name, where the eye lands. */}
                        {error ? (
                          <span className="text-xs text-destructive">{error}</span>
                        ) : line.qtyDelivered - line.qtyReturned > 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {labels.heldLocked.replace(
                              "{qty}",
                              String(line.qtyDelivered - line.qtyReturned)
                            )}
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {line.variantLabel}
                      {line.sku ? (
                        <span className="block text-xs">{line.sku}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Input
                        value={line.price}
                        onChange={(e) =>
                          patchLine(line.key, { price: e.target.value })
                        }
                        inputMode="decimal"
                        className="text-right tabular-nums"
                        aria-label={labels.colPrice}
                        disabled={disabled || line.removed}
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {left}
                    </TableCell>
                    <TableCell>
                      <Input
                        value={line.qty}
                        onChange={(e) => patchLine(line.key, { qty: e.target.value })}
                        inputMode="numeric"
                        className="text-right tabular-nums"
                        aria-label={labels.colQty}
                        aria-invalid={error != null}
                        disabled={disabled || line.removed}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        value={line.discount}
                        onChange={(e) =>
                          patchLine(line.key, { discount: e.target.value })
                        }
                        inputMode="decimal"
                        placeholder="0.00"
                        className="text-right tabular-nums"
                        aria-label={labels.colDiscount}
                        disabled={disabled || line.removed}
                      />
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(lineSubtotal(line), currency)}
                    </TableCell>
                    <TableCell className="text-right">
                      {line.removed ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => restoreLine(line)}
                          disabled={disabled}
                          aria-label={labels.undo}
                        >
                          <HugeiconsIcon
                            icon={Undo02Icon}
                            strokeWidth={2}
                            className="size-4"
                          />
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => requestRemove(line)}
                          disabled={disabled}
                          aria-label={t().common.delete}
                        >
                          <HugeiconsIcon
                            icon={Delete02Icon}
                            strokeWidth={2}
                            className="size-4"
                          />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Phone: one card per line, inputs stacked and thumb-sized. */}
      <div className="flex flex-col gap-2 md:hidden">
        {lines.length === 0 ? (
          <p className="py-2 text-center text-sm text-muted-foreground">
            {labels.emptyItems}
          </p>
        ) : (
          lines.map((line) => {
            const error = lineError(line);
            const qty = lineQty(line) ?? 0;
            const left = Math.max(0, line.maxQty - qty);
            return (
              <div
                key={line.key}
                className={cn("rounded-md border p-3", line.removed && "opacity-50")}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 gap-2">
                    <Thumb
                      imageStorageId={line.imageStorageId}
                      className="size-9 min-w-9"
                    />
                    <div className="min-w-0">
                      <p
                        className={cn(
                          "truncate font-medium",
                          line.removed && "line-through"
                        )}
                      >
                        {line.productName}
                      </p>
                    <p className="text-sm text-muted-foreground">
                      {line.variantLabel}
                      {line.sku ? ` · ${line.sku}` : ""}
                    </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {line.saleItemId === undefined && !line.removed ? (
                      <Badge variant="info">{labels.newLine}</Badge>
                    ) : null}
                    {line.removed ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => restoreLine(line)}
                        disabled={disabled}
                        aria-label={labels.undo}
                      >
                        <HugeiconsIcon
                          icon={Undo02Icon}
                          strokeWidth={2}
                          className="size-4"
                        />
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => requestRemove(line)}
                        disabled={disabled}
                        aria-label={t().common.delete}
                      >
                        <HugeiconsIcon
                          icon={Delete02Icon}
                          strokeWidth={2}
                          className="size-4"
                        />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor={`qty-${line.key}`} className="text-xs">
                      {labels.colQty}
                    </Label>
                    <Input
                      id={`qty-${line.key}`}
                      value={line.qty}
                      onChange={(e) => patchLine(line.key, { qty: e.target.value })}
                      inputMode="numeric"
                      className="h-11 text-right tabular-nums"
                      aria-invalid={error != null}
                      disabled={disabled || line.removed}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`price-${line.key}`} className="text-xs">
                      {labels.colPrice}
                    </Label>
                    <Input
                      id={`price-${line.key}`}
                      value={line.price}
                      onChange={(e) => patchLine(line.key, { price: e.target.value })}
                      inputMode="decimal"
                      className="h-11 text-right tabular-nums"
                      disabled={disabled || line.removed}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor={`disc-${line.key}`} className="text-xs">
                      {labels.colDiscount}
                    </Label>
                    <Input
                      id={`disc-${line.key}`}
                      value={line.discount}
                      onChange={(e) =>
                        patchLine(line.key, { discount: e.target.value })
                      }
                      inputMode="decimal"
                      placeholder="0.00"
                      className="h-11 text-right tabular-nums"
                      disabled={disabled || line.removed}
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      {labels.colStock}
                    </span>
                    <span className="flex h-11 items-center justify-end tabular-nums">
                      {left}
                    </span>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between border-t pt-2">
                  <span className="text-sm text-muted-foreground">
                    {labels.colSubtotal}
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatMoney(lineSubtotal(line), currency)}
                  </span>
                </div>
                {error ? (
                  <p className="mt-1 text-xs text-destructive">{error}</p>
                ) : line.qtyDelivered - line.qtyReturned > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {labels.heldLocked.replace(
                      "{qty}",
                      String(line.qtyDelivered - line.qtyReturned)
                    )}
                  </p>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div className="flex items-center justify-between border-t pt-3 text-sm">
        <span className="text-muted-foreground">{labels.itemsSubtotal}</span>
        <span className="font-semibold tabular-nums">
          {formatMoney(itemsSubtotal, currency)}
        </span>
      </div>

      {/* Removing a saved line moves real stock on save — confirm it once. */}
      <AlertDialog
        open={pendingRemove != null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{labels.removeTitle}</AlertDialogTitle>
            <AlertDialogDescription>{labels.removeBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t().common.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const line = pendingRemove;
                setPendingRemove(null);
                if (line) patchLine(line.key, { removed: true });
              }}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} className="size-4" />
              {t().common.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
