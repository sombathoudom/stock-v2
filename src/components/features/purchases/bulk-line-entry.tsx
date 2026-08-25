"use client";

import { Image01Icon, PlusSignIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { centsToInput, imageUrl, inputToCents, t } from "@/lib/utils";

// One purchase line as built by the bulk entry and kept by the form.
// `key` is a client-side identity (purchaseItemId or `new-<uuid>`) — the
// server only ever sees purchaseItemId / variantId / qty / unitCost.
export type PurchaseLine = {
  key: string;
  purchaseItemId?: Id<"purchaseItems">;
  product: Doc<"products">;
  variantId: Id<"productVariants">;
  size: string;
  color?: string;
  qty: number;
  unitCost: number; // integer cents
};

export type LineDraft = Omit<PurchaseLine, "key">;

/** One editable row of the bulk grid. */
type RowState = {
  variant: Doc<"productVariants">;
  qtyStr: string;
  costStr: string;
};

/**
 * T5 bulk line entry (AGENTS.md: "qty 10 for all sizes" in one tap). Pick a
 * product (the search shows image + name), and EVERY active variant becomes
 * a row — one per size × color combo. A bulk bar copies one qty / unit cost
 * to all rows at once; every cell stays editable individually.
 * Rows with qty ≥ 1 become drafts on Save. The parent remounts this with a
 * per-product key in edit mode so internal state re-initializes cleanly
 * between "add" and "edit" sessions.
 */
export function BulkLineEntry({
  lines,
  editLine,
  onCancelEdit,
  onSubmitLines,
}: {
  /** Existing purchase lines — preloads values for variants already added. */
  lines: PurchaseLine[];
  /** Present = edit mode (preloads product + values); undefined = add mode. */
  editLine?: PurchaseLine;
  onCancelEdit?: () => void;
  /** Called with every row that has qty ≥ 1 — the parent upserts by variantId. */
  onSubmitLines: (drafts: LineDraft[]) => void;
}) {
  const editing = editLine != null;

  const [product, setProduct] = useState<Doc<"products"> | null>(
    editLine?.product ?? null
  );
  const [rows, setRows] = useState<RowState[]>([]);

  // Bulk bar — one value each; only NON-EMPTY fields get copied to all rows.
  const [bulkQty, setBulkQty] = useState("");
  const [bulkCost, setBulkCost] = useState("");

  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // Product picker: server-side prefix search over the catalog, active
  // products only (deactivated items can't join a new line).
  const products = useQuery(api.products.list, {
    paginationOpts: { numItems: 20, cursor: null },
    search: debounced.trim() || undefined,
  });
  const options = useMemo(() => {
    const page = (products?.page ?? []).filter((p) => p.active);
    // Keep the edited line's product pickable even if it is inactive now.
    if (editLine && !page.some((p) => p._id === editLine.product._id)) {
      return [editLine.product, ...page];
    }
    return page;
  }, [products, editLine]);

  // All variant rows of the picked product. Rebuild the grid whenever the
  // product or its variants land; `lines` / `editLine` are mount-time values
  // (the parent remounts this component per mode via its key).
  const variants = useQuery(
    api.products.listVariants,
    product ? { productId: product._id } : "skip"
  );
  useEffect(() => {
    if (!product || variants === undefined) return;
    const sizeOrder = new Map(product.sizes.map((s, i) => [s, i]));
    const colorOrder = new Map(product.colors.map((c, i) => [c, i]));
    const active = variants
      .filter((v) => v.active)
      .sort((a, b) => {
        const sa = sizeOrder.get(a.size) ?? 0;
        const sb = sizeOrder.get(b.size) ?? 0;
        if (sa !== sb) return sa - sb;
        return (colorOrder.get(a.color ?? "") ?? 0) - (colorOrder.get(b.color ?? "") ?? 0);
      });
    // Inactive variants that already have a line in this purchase stay
    // editable: a group edit replaces the whole product, so dropping them
    // here would silently delete their lines (and their stock rows).
    const inactive = variants
      .filter((v) => !v.active && lines.some((l) => l.variantId === v._id))
      .sort((a, b) => {
        const sa = sizeOrder.get(a.size) ?? 0;
        const sb = sizeOrder.get(b.size) ?? 0;
        if (sa !== sb) return sa - sb;
        return (colorOrder.get(a.color ?? "") ?? 0) - (colorOrder.get(b.color ?? "") ?? 0);
      });
    // The rows initialize only after the selected product's async variants arrive.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRows(
      [...active, ...inactive].map((v) => {
        const existing = lines.find((l) => l.variantId === v._id);
        const edited = editLine?.variantId === v._id ? editLine : undefined;
        const source = edited ?? existing;
        return {
          variant: v,
          qtyStr: source ? String(source.qty) : "",
          costStr: source
            ? centsToInput(source.unitCost)
            : centsToInput(v.cost ?? product.defaultCost),
        };
      })
    );
    // The parent remounts this editor for each mode; these are initial values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product, variants]);

  function selectProduct(next: Doc<"products"> | null) {
    setProduct(next);
  }

  /** Copy every non-empty bulk field to all rows (the one-tap path). */
  function applyToAll() {
    const qty = /^\d{1,6}$/.test(bulkQty.trim()) ? bulkQty.trim() : null;
    const cost = inputToCents(bulkCost);
    setRows((rs) =>
      rs.map((r) => ({
        ...r,
        qtyStr: qty ?? r.qtyStr,
        costStr: cost != null ? bulkCost.trim() : r.costStr,
      }))
    );
  }

  // Parse every row: rows with qty ≥ 1 must have a valid cost; anything
  // malformed blocks the whole save
  // (AGENTS.md: no silent failures).
  const { drafts, invalid } = useMemo(() => {
    const out: LineDraft[] = [];
    let bad = false;
    for (const r of rows) {
      if (r.qtyStr.trim() === "") continue;
      const qtyNum = /^\d{1,6}$/.test(r.qtyStr.trim())
        ? parseInt(r.qtyStr.trim(), 10)
        : null;
      const qtyValid = qtyNum != null && qtyNum >= 1 && qtyNum <= 1_000_000;
      const costNum = inputToCents(r.costStr);
      const costValid = costNum != null && costNum >= 0;
      if (!qtyValid || !costValid) {
        bad = true;
        continue;
      }
      const existing = lines.find((l) => l.variantId === r.variant._id);
      out.push({
        purchaseItemId:
          editLine?.variantId === r.variant._id
            ? editLine.purchaseItemId
            : existing?.purchaseItemId,
        product: product!,
        variantId: r.variant._id,
        size: r.variant.size,
        color: r.variant.color,
        qty: qtyNum!,
        unitCost: costNum!,
      });
    }
    return { drafts: out, invalid: bad };
  }, [rows, product, lines, editLine]);

  function submit() {
    if (!product) return;
    if (drafts.length === 0) {
      toast.error(t().purchases.needLines);
      return;
    }
    onSubmitLines(drafts);
  }

  const canSubmit = product != null && !invalid && drafts.length > 0;

  // Product _id → name lookup for Base UI's itemToStringLabel: the closed
  // input shows the picked product's name, never its raw id (misses fall
  // back to the id).
  const labelByValue = useMemo(
    () => new Map<string, string>(options.map((p) => [String(p._id), p.name])),
    [options]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {editing ? t().purchases.editItemTitle : t().purchases.addItemTitle}
        </CardTitle>
        <CardDescription>{t().purchases.linesHint}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label>{t().purchases.product}</Label>
          <Combobox
            items={options.map((p) => p._id)}
            itemToStringLabel={(item) => {
              if (item == null) return "";
              const value =
                typeof item === "object" && "value" in item
                  ? String((item as { value: unknown }).value)
                  : String(item);
              return labelByValue.get(value) ?? value;
            }}
            value={product?._id ?? null}
            disabled={editing}
            onValueChange={(value) => {
              setQuery("");
              selectProduct(options.find((p) => p._id === value) ?? null);
            }}
            // Only real typing drives the search — Base UI's programmatic
            // fills (selection sync) must not re-filter by the product name.
            onInputValueChange={(inputValue, eventDetails) => {
              if (eventDetails?.reason === "input-change") setQuery(inputValue);
            }}
          >
            <ComboboxInput placeholder={t().purchases.pickProduct} showClear />
            <ComboboxContent>
              <ComboboxEmpty>{t().common.noResults}</ComboboxEmpty>
              <ComboboxList>
                {options.map((p) => (
                  <ComboboxItem key={p._id} value={p._id}>
                    {/* Image + name (AGENTS.md T5): a 32px thumbnail, or the
                        placeholder icon when the product has no photo. */}
                    {p.imageStorageId ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={imageUrl(p.imageStorageId)}
                        alt=""
                        className="size-8 shrink-0 rounded-md border object-cover"
                      />
                    ) : (
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                        <HugeiconsIcon
                          icon={Image01Icon}
                          strokeWidth={2}
                          className="size-4"
                        />
                      </span>
                    )}
                    <span className="min-w-0 truncate">{p.name}</span>
                  </ComboboxItem>
                ))}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </div>

        {product && rows.length > 0 && (
          <>
            {/* Bulk bar — type once, apply to all sizes. */}
            <div className="grid gap-2 rounded-md border p-3">
              <p className="text-sm font-medium">{t().purchases.applyToAll}</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="grid gap-1">
                  <Label htmlFor="bulk-qty" className="text-xs text-muted-foreground">
                    {t().purchases.qty}
                  </Label>
                  <Input
                    id="bulk-qty"
                    className="h-11 md:h-9"
                    inputMode="numeric"
                    placeholder="10"
                    value={bulkQty}
                    onChange={(e) => setBulkQty(e.target.value)}
                  />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor="bulk-cost" className="text-xs text-muted-foreground">
                    {t().purchases.unitCost}
                  </Label>
                  <Input
                    id="bulk-cost"
                    className="h-11 md:h-9"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={bulkCost}
                    onChange={(e) => setBulkCost(e.target.value)}
                  />
                </div>
              </div>
              <Button
                type="button"
                variant="secondary"
                className="w-full sm:w-fit"
                onClick={applyToAll}
                disabled={
                  bulkQty.trim() === "" && bulkCost.trim() === ""
                }
              >
                {t().purchases.applyToAll}
              </Button>
            </div>

            {/* Desktop: one bordered table-like grid, one row per variant. */}
            <div className="hidden overflow-hidden rounded-md border md:block">
              <div className="grid grid-cols-[minmax(0,1fr)_5rem_7rem] items-center gap-2 border-b bg-muted/50 px-3 py-2 text-sm font-medium">
                <span>{t().purchases.size}</span>
                <span className="text-right">{t().purchases.qty}</span>
                <span className="text-right">{t().purchases.unitCost}</span>
              </div>
              {rows.map((r, i) => (
                <BulkRow
                  key={r.variant._id}
                  row={r}
                  border={i < rows.length - 1}
                  onQty={(v) => setRow(setRows, r.variant._id, { qtyStr: v })}
                  onCost={(v) => setRow(setRows, r.variant._id, { costStr: v })}
                />
              ))}
            </div>

            {/* Phone: stacked rows, thumb-friendly inputs. */}
            <div className="flex flex-col gap-2 md:hidden">
              {rows.map((r) => (
                <Card key={r.variant._id}>
                  <CardContent className="grid gap-2 p-3">
                    <p className="text-sm font-medium">
                      {r.variant.color
                        ? `${r.variant.size} · ${r.variant.color}`
                        : r.variant.size}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <CellInput
                        label={t().purchases.qty}
                        inputMode="numeric"
                        value={r.qtyStr}
                        onChange={(v) =>
                          setRow(setRows, r.variant._id, { qtyStr: v })
                        }
                      />
                      <CellInput
                        label={t().purchases.unitCost}
                        inputMode="decimal"
                        value={r.costStr}
                        onChange={(v) =>
                          setRow(setRows, r.variant._id, { costStr: v })
                        }
                      />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </>
        )}

        {product && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">{t().purchases.emptyLines}</p>
        )}

        {invalid && (
          <p className="text-sm text-destructive">{t().purchases.invalidLines}</p>
        )}

        <div className="flex items-center gap-2">
          <Button type="button" disabled={!canSubmit} onClick={submit}>
            <HugeiconsIcon
              icon={editing ? Tick02Icon : PlusSignIcon}
              strokeWidth={2}
              className="size-4"
            />
            {editing ? t().purchases.saveItem : t().purchases.addLine}
          </Button>
          {editing && (
            <Button type="button" variant="outline" onClick={onCancelEdit}>
              {t().common.cancel}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/** Patch one row's string field by variant id. */
function setRow(
  setRows: (updater: (rs: RowState[]) => RowState[]) => void,
  variantId: Id<"productVariants">,
  patch: Partial<Pick<RowState, "qtyStr" | "costStr">>
) {
  setRows((rs) =>
    rs.map((r) => (r.variant._id === variantId ? { ...r, ...patch } : r))
  );
}

/** One desktop grid row: size label + quantity and cost inputs. */
function BulkRow({
  row,
  border,
  onQty,
  onCost,
}: {
  row: RowState;
  border: boolean;
  onQty: (value: string) => void;
  onCost: (value: string) => void;
}) {
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_5rem_7rem] items-center gap-2 px-3 py-2 ${
        border ? "border-b" : ""
      }`}
    >
      <span className="truncate text-sm font-medium">
        {row.variant.color ? `${row.variant.size} · ${row.variant.color}` : row.variant.size}
      </span>
      <CellInput
        label={t().purchases.qty}
        inputMode="numeric"
        value={row.qtyStr}
        onChange={onQty}
      />
      <CellInput
        label={t().purchases.unitCost}
        inputMode="decimal"
        value={row.costStr}
        onChange={onCost}
      />
    </div>
  );
}

/** A 44px-tall numeric cell input. */
function CellInput({
  label,
  inputMode,
  value,
  onChange,
}: {
  label: string;
  inputMode: "numeric" | "decimal";
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-0.5">
      <Input
        className="h-11 px-2 text-right tabular-nums md:h-9"
        inputMode={inputMode}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
