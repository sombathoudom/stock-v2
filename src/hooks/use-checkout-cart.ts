"use client";

import { useCallback } from "react";

import { usePersistentState } from "@/hooks/use-persistent-state";

// T10 — POS cart (AGENTS.md: "the POS cart gets one useCheckoutCart hook").
// The cart is UI state that survives reloads like every other preference.

/** One cart line. price/label/stock are display snapshots from the grid — the
 *  server re-reads price and re-checks stock at checkout. */
export type CartLine = {
  /** Unique per add — lines are never merged across adds. */
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
};

/** Identity of a line: the per-add key. Legacy persisted carts (pre-key)
 *  fall back to variantId so an open cart survives the upgrade — those old
 *  carts were deduped by variant, so the fallback stays unique too. */
export const cartLineId = (line: CartLine) => line.key ?? line.variantId;

export function useCheckoutCart() {
  const [cart, setCart] = usePersistentState<CartLine[]>("pos:cart", []);

  /** Add one variant (fast POS tap-to-add, qty 1). A repeated tap on the same
   *  card bumps the EXISTING line's qty — clamped to the stock snapshot — so
   *  five taps give one line ×5, not five lines. A line that already carries
   *  a custom discount is left untouched and the tap opens a fresh line, so
   *  the T10 per-item discount stays intact per line. Legacy persisted lines
   *  have no stock snapshot — their + stays unclamped (server still checks). */
  const addVariant = useCallback(
    (line: Omit<CartLine, "key">) => {
      setCart((current) => {
        const stock = line.stock ?? Number.POSITIVE_INFINITY;
        const existing = current.find(
          (c) => c.variantId === line.variantId && !c.discount
        );
        if (existing) {
          // Already at the stock cap — no-op, never a second line for the
          // same variant (the cart's + stepper is the qty control).
          if (existing.qty >= stock) return current;
          return current.map((c) =>
            (c.key ?? c.variantId) === (existing.key ?? existing.variantId)
              ? { ...c, qty: c.qty + 1 }
              : c
          );
        }
        // Out of stock — no-op.
        if (stock < 1) return current;
        return [...current, { ...line, key: crypto.randomUUID() }];
      });
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

  return { cart, addVariant, updateLine, removeLine, clear };
}
