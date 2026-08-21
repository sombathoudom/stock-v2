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
  /** Current database stock of this variant (ledger sum, from the server).
   * Same value on every line of the variant — the base of the shared stock
   * projection, never displayed raw. */
  stock: number;
  /** Highest this line can be raised to: its own billed pieces + shelf stock.
   * Drives the "Available stock" column — the real shelf the staff can see. */
  maxQty: number;
  /** Hard cap for the quantity box — same as maxQty on every line: a raise
   * is measured as a DELTA against the line's billed quantity, so the only
   * real ceiling is the line's own pieces plus the shared shelf projection
   * (availableForLine), never a delivered-orders-only cap. */
  inputMax: number;
  /** What a RAISE's extra pieces are priced at: the variant's CURRENT sell
   * price (server-derived, same derivation saveEdit uses for the split
   * line) — the extra pieces are a new purchase at today's price. */
  currentPrice: number;
  /** Marked for removal — applied (and returned to stock) on save. */
  removed: boolean;
  /** What happened to the pieces that came back (from the ledger): a line
   * removed by a return says "Returned · Sellable" / "Returned · Damaged"
   * instead of the generic "Removed". null = no return history. */
  returnedOutcome: "sellable" | "damaged" | null;
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

/** What the line keeps billing after the pending resolutions that drop
 * pieces off the bill — the same "current billed quantity" the server
 * measures deltas against. */
export function lineBilledAfter(line: EditLine, billCut = 0): number {
  return Math.max(0, line.originalQty - billCut);
}

/** The line's subtotal, priced exactly as saveEdit bills it: the billed
 * pieces keep the line's own price and discount, but a RAISE's extra pieces
 * are a new purchase at the variant's CURRENT price — so the number shown
 * and the number enforced on save can never disagree. */
export function lineSubtotal(line: EditLine, billCut = 0): number {
  if (line.removed) return 0;
  const qty = lineQty(line);
  const price = linePrice(line);
  const discount = lineDiscount(line);
  if (qty == null || price == null || discount == null) return 0;
  const billed = lineBilledAfter(line, billCut);
  const billedPieces = Math.min(qty, billed);
  const raisedPieces = Math.max(0, qty - billed);
  return Math.max(
    0,
    billedPieces * price - discount + raisedPieces * line.currentPrice
  );
}

/**
 * What's wrong with this row, in shop language — or null when it's fine.
 * Client-side only: it stops a doomed save early and points at the row, but
 * the server checks all of it again and is the one that decides.
 *
 * `resolvedQty` is the pieces of this line already covered by pending
 * return/correction resolutions — the floor shrinks by exactly that much,
 * because the server applies the resolutions before it checks the floor.
 *
 * `availability` is the shared variant-level projection (projectAvailability)
 * — the SAME numbers the Available stock column renders, so the validation
 * error and the displayed stock can never disagree.
 *
 * `billCut` is the line's pending resolutions dropping off the bill — the
 * current billed baseline shrinks by it, and the raise limit is measured
 * against THAT baseline: the line may grow by whatever the shared shelf
 * projection still has, up to `max = billedAfter + shelf` — never by
 * comparing the typed quantity directly against stock.
 */
export function lineError(
  line: EditLine,
  resolvedQty = 0,
  availability?: ReadonlyMap<string, VariantAvailability>,
  billCut = 0
): string | null {
  if (line.removed) return null;
  const labels = t().sales.edit;
  const qty = lineQty(line);
  if (qty == null || qty < 1) return labels.invalidQty;
  // The floor is what the customer currently holds — the historical
  // delivered count minus what already came back (the server checks the
  // same derived bound before applying the diff).
  const held = line.qtyDelivered - line.qtyReturned - resolvedQty;
  if (qty < held) {
    return labels.belowHeld.replace("{qty}", String(held));
  }
  // Aggregate stock check, per variant: every line of the variant shares one
  // projection, so duplicate lines can't each draw the full shelf. The
  // ceiling is the line's own billed pieces PLUS what the shelf can still
  // fund — a raise only needs the DELTA, so a line at 1 with 9 on the shelf
  // may go to 10, not to 9.
  if (availability !== undefined) {
    const available = availableForLine(line, availability);
    if (qty > available) {
      const billedAfter = lineBilledAfter(line, billCut);
      const more = Math.max(0, available - billedAfter);
      return labels.raiseLimit
        .replace("{qty}", String(more))
        .replace("{max}", String(available));
    }
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

/** One variant's projected stock, shared by the Available stock column and
 * the quantity validation — one source, so the number displayed and the
 * number enforced can never disagree (they used to: the column read the real
 * shelf while the error read a per-line cap, and a restored historical
 * return showed "8" next to "Only 0 available"). */
export type VariantAvailability = {
  /** Stock available NOW: current database stock. Pending returns aren't
   * saved yet, so they don't move this number — the "+X when saved"
   * description covers them. */
  shelf: number;
  /** Projected stock AFTER this save: current stock + the save's net
   * movements (pending returns in, reduced lines back, grown/new lines
   * drawn) — the same per-variant net the server's assertStockCovers
   * validates. A persisted return contributes 0: its piece is already
   * inside `shelf`. */
  after: number;
};

/**
 * The ONE stock projection for the Edit Sale page, per variant.
 *
 *   shelf = current database stock
 *   net   = Σ per line: returnIn (pending sellable returns / corrections)
 *           + billedAfter − activeQty (a reduced line sends the difference
 *           back; a grown/new line draws it — the same per-line net the
 *           server's saveEdit computes as returnIn + billedOld − qty)
 *   after = shelf + net
 *
 * A PERSISTED return is already inside current database stock (its return
 * movement landed) and its line bills nothing: it adds to neither the
 * pending-return count nor the drawn quantity, so reloading the page never
 * double-counts it. `returnInByLine` / `billCutByLine` are keyed by line
 * key and carry the pending-resolution quantities: what flows back in
 * (sellable returns + delivery corrections) and what drops off the bill
 * (every return outcome — damaged pieces leave the bill without adding
 * stock). `stock` on each line is the variant's current ledger stock (the
 * same for every line of the variant).
 */
export function projectAvailability(
  lines: EditLine[],
  returnInByLine: ReadonlyMap<string, number>,
  billCutByLine: ReadonlyMap<string, number>
): Map<string, VariantAvailability> {
  const byVariant = new Map<string, { db: number; net: number }>();
  for (const line of lines) {
    const cur = byVariant.get(line.variantId) ?? { db: 0, net: 0 };
    // Same variant stock on every line; max guards a stale search-result
    // race against the loaded edit snapshot (the server re-validates anyway).
    cur.db = Math.max(cur.db, line.stock);
    const returnIn = returnInByLine.get(line.key) ?? 0;
    const billCut = billCutByLine.get(line.key) ?? 0;
    // What the line keeps billing after the pending returns — the pieces
    // this save does NOT take out again (they left the shelf long ago).
    const billedAfter = Math.max(0, line.originalQty - billCut);
    // What the line asks for now. Removed lines bill nothing; an unparsable
    // quantity is an error row anyway and takes nothing for the projection.
    const activeQty = line.removed ? 0 : (lineQty(line) ?? 0);
    // This line's net movement on save: returns flow in, a reduced line
    // gives the difference back, a grown/new line draws it. Mirrors the
    // server's per-variant net (assertStockCovers runs on the same number).
    cur.net += returnIn + billedAfter - activeQty;
    byVariant.set(line.variantId, cur);
  }
  const out = new Map<string, VariantAvailability>();
  for (const [variantId, v] of byVariant) {
    out.set(variantId, { shelf: v.db, after: v.db + v.net });
  }
  return out;
}

/** What THIS line can still take before its variant's projected stock runs
 * out — the other lines of the same variant already reserve their share, so
 * duplicate lines each see the remaining shelf, never the full number. The
 * line's own request is added back because `after` already excludes it. */
export function availableForLine(
  line: EditLine,
  availability: ReadonlyMap<string, VariantAvailability>
): number {
  const v = availability.get(line.variantId);
  if (!v) return line.inputMax;
  const activeQty = line.removed ? 0 : (lineQty(line) ?? 0);
  return Math.max(0, v.after + activeQty);
}

/** What a REMOVED row offers the user — the pending/persisted distinction,
 * derived from server data (returnedOutcome) and pending form state, never
 * from styling. A persisted return is immutable history; only pending
 * client-side actions are undoable. */
export type RemovedLineState =
  | "readonly" // persisted return: history, no Undo, no delete
  | "undo-resolution" // pending return: Undo pops the pending resolution
  | "undo"; // pending removal / cancelled history: plain Undo

export function removedLineState(
  line: EditLine,
  pendingOutcome?: "sellable" | "damaged" | "incorrect"
): RemovedLineState {
  if (line.returnedOutcome != null) return "readonly";
  if (pendingOutcome != null) return "undo-resolution";
  return "undo";
}

export function SaleEditItemsTable({
  lines,
  onChange,
  currency,
  disabled,
  resolvedQtyByLine,
  onResolveLine,
  billCutByLine,
  availabilityByVariant,
  pendingOutcomeByLine,
  onUndoResolution,
}: {
  lines: EditLine[];
  onChange: (next: EditLine[]) => void;
  currency: string;
  disabled: boolean;
  /** Pending-resolution pieces per line key (returnable outcomes only —
   * still_with_customer doesn't shrink the floor). */
  resolvedQtyByLine: Record<string, number>;
  /** A line whose pieces are held by the customer was asked to drop below
   * the floor — the page opens the physical-outcome dialog for it. */
  onResolveLine: (line: EditLine) => void;
  /** Every pending resolution's pieces per line key (all outcomes — what
   * drops off the bill, feeding the billed baseline and the line subtotal
   * exactly as the server measures them). */
  billCutByLine: Record<string, number>;
  /** The shared per-variant stock projection — the one source for the
   * Available stock column and the quantity validation (lineError). */
  availabilityByVariant: ReadonlyMap<string, VariantAvailability>;
  /** Pending (unsaved) return per line key, from the change summary —
   * outcome "sellable" when a sellable return or delivery correction is
   * pending on the line, "damaged" for a damaged return; qty is the pieces
   * the save will bring back in. */
  pendingOutcomeByLine: Record<
    string,
    { outcome: "sellable" | "damaged" | "incorrect"; qty: number }
  >;
  /** Undo the line's MOST RECENT pending resolution (returns the line to
   * its pre-resolution state; nothing is written until Save). */
  onUndoResolution: (line: EditLine) => void;
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
        stock: found.stock,
        maxQty: found.stock,
        inputMax: found.stock,
        currentPrice: found.price,
        removed: false,
        returnedOutcome: null,
      },
    ]);
  }

  /** A row the user asked to drop. New rows just disappear (nothing of them
   * exists yet); saved rows are marked and confirmed, because removing one
   * moves real stock when the page is saved. A row whose pieces are still
   * with the customer can't be silently removed — the resolution dialog
   * captures what physically happened to those pieces instead. */
  function requestRemove(line: EditLine) {
    if (line.saleItemId === undefined) {
      onChange(lines.filter((l) => l.key !== line.key));
      return;
    }
    const held =
      line.qtyDelivered - line.qtyReturned - (resolvedQtyByLine[line.key] ?? 0);
    if (held > 0) {
      onResolveLine(line);
      return;
    }
    setPendingRemove(line);
  }

  /** Put a removed row back on the bill. A row that was already billing
   * nothing when the page opened comes back at one piece — restoring it to
   * zero would just be an invalid row the user has to fix.
   *
   * Not offered on delivered orders: there the server refuses any change to
   * an existing (already-billed) line (DELIVERED_LOCKED_LINES), so the Undo
   * button is hidden and removed lines read as history — new pieces come in
   * through the add-item search instead. */
  function restoreLine(line: EditLine) {
    const qty = lineQty(line);
    patchLine(line.key, {
      removed: false,
      ...(qty == null || qty < 1 ? { qty: "1" } : {}),
    });
  }

  const itemsSubtotal = lines.reduce(
    (sum, l) => sum + lineSubtotal(l, billCutByLine[l.key] ?? 0),
    0
  );

  /** Everything one row needs to render — shared by the desktop table and
   * the phone cards so the two can never drift. */
  function rowView(line: EditLine) {
    const resolved = resolvedQtyByLine[line.key] ?? 0;
    const billCut = billCutByLine[line.key] ?? 0;
    const error = lineError(line, resolved, availabilityByVariant, billCut);
    const qty = lineQty(line) ?? 0;
    const held = line.qtyDelivered - line.qtyReturned - resolved;
    const variant = availabilityByVariant.get(line.variantId);
    // Same projection the validation uses — the column can never show a
    // number the qty check disagrees with.
    const shelf = variant?.shelf ?? line.stock;
    const after = variant?.after ?? line.stock;
    const pending = pendingOutcomeByLine[line.key];
    const removedAction = line.removed
      ? removedLineState(line, pending?.outcome)
      : null;
    // Pieces this line adds BEYOND its billed baseline — they bill at the
    // variant's CURRENT price, so when that differs from the line's own
    // price the row says so (the displayed subtotal already prices them).
    const raised = Math.max(0, qty - lineBilledAfter(line, billCut));
    const pricedAtToday = raised > 0 && line.currentPrice !== linePrice(line);
    return { error, qty, held, shelf, after, pending, removedAction, pricedAtToday };
  }

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
                const {
                  error,
                  qty,
                  held,
                  shelf,
                  after,
                  pending,
                  removedAction,
                  pricedAtToday,
                } = rowView(line);
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
                            <Badge
                              variant={
                                (line.returnedOutcome ?? pending?.outcome) ===
                                "damaged"
                                  ? "destructive"
                                  : "info"
                              }
                            >
                              {line.returnedOutcome != null
                                ? line.returnedOutcome === "sellable"
                                  ? labels.returnedSellable
                                  : labels.returnedDamaged
                                : pending
                                  ? pending.outcome === "sellable"
                                    ? labels.pendingReturnSellable
                                    : pending.outcome === "damaged"
                                      ? labels.pendingReturnDamaged
                                      : labels.removed
                                  : labels.removed}
                            </Badge>
                          ) : null}
                        </span>
                        {/* Row errors sit under the name, where the eye lands.
                            A held-line floor violation offers the resolution
                            dialog right there — staff never leave the page. */}
                        {error ? (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs text-destructive">{error}</span>
                            {held > 0 && qty < held ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => onResolveLine(line)}
                                disabled={disabled}
                                className="h-6 px-2 text-xs"
                              >
                                {labels.resolveLine}
                              </Button>
                            ) : null}
                          </span>
                        ) : held > 0 ? (
                          <span className="text-xs text-muted-foreground">
                            {labels.heldLocked.replace("{qty}", String(held))}
                          </span>
                        ) : line.removed ? (
                          line.returnedOutcome != null ? (
                            // Persisted return — history, not a row to fix.
                            <span className="text-xs text-muted-foreground">
                              {labels.historicalReturn}
                            </span>
                          ) : pending?.outcome === "sellable" ? (
                            <span className="text-xs text-muted-foreground">
                              {labels.pendingReturnStockIn.replace(
                                "{qty}",
                                String(pending.qty)
                              )}
                            </span>
                          ) : null
                        ) : pricedAtToday ? (
                          <span className="text-xs text-muted-foreground">
                            {labels.deltaPriceHint}
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
                      {after === shelf
                        ? shelf
                        : `${shelf} → ${Math.max(0, after)}`}
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
                      {formatMoney(
                        lineSubtotal(line, billCutByLine[line.key] ?? 0),
                        currency
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {line.removed ? (
                        removedAction === "undo-resolution" ? (
                          // Pending return — Undo pops the not-yet-saved
                          // resolution; nothing touches the database.
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => onUndoResolution(line)}
                            disabled={disabled}
                            aria-label={labels.undo}
                          >
                            <HugeiconsIcon
                              icon={Undo02Icon}
                              strokeWidth={2}
                              className="size-4"
                            />
                          </Button>
                        ) : removedAction === "undo" ? (
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
                        ) : null
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
            const {
              error,
              qty,
              held,
              shelf,
              after,
              pending,
              removedAction,
              pricedAtToday,
            } = rowView(line);
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
                      <Badge
                        variant={
                          (line.returnedOutcome ?? pending?.outcome) ===
                          "damaged"
                            ? "destructive"
                            : "info"
                        }
                      >
                        {line.returnedOutcome != null
                          ? line.returnedOutcome === "sellable"
                            ? labels.returnedSellable
                            : labels.returnedDamaged
                          : pending
                            ? pending.outcome === "sellable"
                              ? labels.pendingReturnSellable
                              : pending.outcome === "damaged"
                                ? labels.pendingReturnDamaged
                                : labels.removed
                            : labels.removed}
                      </Badge>
                    ) : null}
                    {line.removed ? (
                      removedAction === "undo-resolution" ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onUndoResolution(line)}
                          disabled={disabled}
                          aria-label={labels.undo}
                        >
                          <HugeiconsIcon
                            icon={Undo02Icon}
                            strokeWidth={2}
                            className="size-4"
                          />
                        </Button>
                      ) : removedAction === "undo" ? (
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
                      ) : null
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
                      {after === shelf
                        ? shelf
                        : `${shelf} → ${Math.max(0, after)}`}
                    </span>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between border-t pt-2">
                  <span className="text-sm text-muted-foreground">
                    {labels.colSubtotal}
                  </span>
                  <span className="font-medium tabular-nums">
                    {formatMoney(
                      lineSubtotal(line, billCutByLine[line.key] ?? 0),
                      currency
                    )}
                  </span>
                </div>
                {error ? (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <p className="text-xs text-destructive">{error}</p>
                    {held > 0 && qty < held ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onResolveLine(line)}
                        disabled={disabled}
                        className="h-7 px-2 text-xs"
                      >
                        {labels.resolveLine}
                      </Button>
                    ) : null}
                  </div>
                ) : held > 0 ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {labels.heldLocked.replace("{qty}", String(held))}
                  </p>
                ) : line.removed ? (
                  line.returnedOutcome != null ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {labels.historicalReturn}
                    </p>
                  ) : pending?.outcome === "sellable" ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {labels.pendingReturnStockIn.replace(
                        "{qty}",
                        String(pending.qty)
                      )}
                    </p>
                  ) : null
                ) : pricedAtToday ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {labels.deltaPriceHint}
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
