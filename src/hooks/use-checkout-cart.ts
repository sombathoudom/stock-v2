"use client";

import { useCallback } from "react";

import { usePersistentState } from "@/hooks/use-persistent-state";

// T10 — POS cart (AGENTS.md: "the POS cart gets one useCheckoutCart hook").
// The cart is UI state that survives reloads like every other preference.

/** One cart line. price/label/stock are display snapshots from the grid — the
 *  server re-reads price and re-checks stock at checkout. */
export type CartLine = {
  /** Stable identity for cart editing. */
  key: string;
  variantId: string;
  label: string;
  price: number; // display-only snapshot, integer cents
  qty: number;
  discount: string; // money input string, "" = no item discount
  /** Stock snapshot at add time — clamps the cart's + stepper. Display-only:
   *  the checkout mutation re-checks real ledger stock server-side. */
  stock?: number;
  /** Product photo for the cart line + review modal; missing = placeholder. */
  imageStorageId?: string;
  /** Combo-set lines: the set recipe this line came from — the server reads
   *  the price from it (client never sends a set price). */
  setId?: string;
  /** Shared by all lines of ONE sold set instance (grouping + display). */
  setGroupId?: string;
  /** Set name for the cart grouping header (display only). */
  setName?: string;
};

/** Identity of a line: the per-add key. Legacy persisted carts (pre-key)
 *  fall back to variantId so an open cart survives the upgrade — those old
 *  carts were deduped by variant, so the fallback stays unique too. */
export const cartLineId = (line: CartLine) => line.key ?? line.variantId;

/** Add a variant or increase its existing line when the total fits stock.
 *  Combo-set lines never merge — a set instance's lines stay their own rows
 *  (they carry a set price + group id), so they're always appended fresh. */
export function addCartLine(
  current: CartLine[],
  line: Omit<CartLine, "key">,
  key: string
): CartLine[] {
  const stock = line.stock ?? Number.POSITIVE_INFINITY;
  // Cumulative qty of this variant already in the cart (any line — set or
  // single) so the stock clamp can't be dodged by mixing.
  const variantQty = current.reduce(
    (total, item) =>
      item.variantId === line.variantId ? total + item.qty : total,
    0
  );

  if (line.qty < 1 || variantQty + line.qty > stock) return current;

  // Set lines are always their own row; only plain single lines merge with an
  // existing plain line of the same variant.
  if (!line.setGroupId) {
    const existingIndex = current.findIndex(
      (item) => item.variantId === line.variantId && !item.setGroupId
    );
    if (existingIndex !== -1) {
      return current.map((item, index) =>
        index === existingIndex ? { ...item, qty: item.qty + line.qty } : item
      );
    }
  }
  return [...current, { ...line, key }];
}

export function useCheckoutCart() {
  const [cart, setCart] = usePersistentState<CartLine[]>("pos:cart", []);

  /** Add one variant (fast POS tap-to-add, qty 1), merging repeat taps. */
  const addVariant = useCallback(
    (line: Omit<CartLine, "key">) => {
      setCart((current) => addCartLine(current, line, crypto.randomUUID()));
    },
    [setCart]
  );

  /** Add several lines at once (a combo set's components). Applied in order
   *  through addCartLine so the cumulative stock clamp still holds; set lines
   *  never merge (they carry a setGroupId), so each lands as its own row. */
  const addLines = useCallback(
    (lines: Omit<CartLine, "key">[]) => {
      setCart((current) =>
        lines.reduce(
          (acc, line) => addCartLine(acc, line, crypto.randomUUID()),
          current,
        ),
      );
    },
    [setCart]
  );

  /** Patch one line (qty, discount) by its line key. */
  const updateLine = useCallback(
    (lineKey: string, patch: Partial<CartLine>) => {
      setCart((current) =>
        current.map((c) =>
          // key identifies the line; legacy persisted carts fall back to
          // variantId until their lines are re-added.
          (c.key ?? c.variantId) === lineKey ? { ...c, ...patch } : c
        )
      );
    },
    [setCart]
  );

  const removeLine = useCallback(
    (lineKey: string) => {
      setCart((current) =>
        current.filter((c) => (c.key ?? c.variantId) !== lineKey)
      );
    },
    [setCart]
  );

  /** Empty the cart — called after a sale completes. */
  const clear = useCallback(() => {
    setCart([]);
  }, [setCart]);

  return { cart, addVariant, addLines, updateLine, removeLine, clear };
}
