# Combo Sets (Bundles) — Design Doc for Review

Status: **proposal, not yet implemented.** For owner + senior sign-off before any code.

## Goal

Sell a "set" of existing products together at a special price. Example: a
uniform set = 1 shirt + 1 t-shirt + 1 pants. Each item keeps its own stock and
its own cost (bought from different suppliers). The set just changes the
**sell price per item** when sold together.

## Confirmed requirements (from the owner)

1. A set is **one recipe** (1 shirt + 1 t-shirt + 1 pants) — NOT one product
   per size combination. (5×5×5 = 125 combos would be unmanageable.)
2. Each component in the set has its **own set price**, typed when creating the
   set. Example — normal vs set:
   - Shirt $6 → set $6
   - T-shirt $4 → set $3
   - Pants $7 → set $6
   - Set total = $15 (sum of component set prices).
3. **Same set price for every size** of a component (Shirt is $6 in the set
   whether M or 3XL).
4. **Mix-and-match sizes at checkout**: the cashier picks the size of each
   component (shirt L + t-shirt XL + pants M is allowed).
5. Selling normally uses the product's **normal price** ($17 total); the set
   price applies ONLY inside a set. The two never overwrite each other.
6. **Stock is derived from components** — the set holds NO stock of its own.
   Selling 1 set deducts 1 of each component variant from the ledger.
7. **Profit is per item** = its set price − its own weighted-average cost, and
   the per-item profits sum to the set profit.

## Why NOT a set product with its own stock

Giving a set its own stock number creates a SECOND source of truth that will
drift from the component stock — the exact "system says 1 but real stock is 0"
bug the ledger design prevents (AGENTS.md rule #1). So the set stores no
quantity; its availability and its deductions both come from the components.

## The key constraint (from the code)

Checkout is a strict endpoint: the client sends only `variantId`, `qty`,
`discount`. The server ALWAYS re-derives `unitPrice = variant.price ??
product.defaultPrice` and ignores any client price (`checkoutLine` doesn't even
define a price field). This is the "server re-derives every value from the DB"
rule. So a set price can NOT be a raw number the client sends — the server must
read it from a set recipe stored in the DB.

## Design: set = a DB recipe; checkout reads the price from it

### New tables

```
sets  (the recipe header)
  name: string
  nameLower: string        // prefix search
  active: boolean          // soft-delete only (never hard-delete; may be on past sales)
  imageStorageId?: _storage  // optional set photo, like products
  .index("by_nameLower", ["nameLower"])

setItems  (one row per component in the set)
  setId: id("sets")
  productId: id("products")   // the component product
  qty: number                 // usually 1
  setPrice: number            // integer cents — the item's price INSIDE this set
  .index("by_set", ["setId"])
```

Notes:
- `setPrice` is per component, same across sizes (requirement #3). Size is
  chosen at checkout, not stored on the recipe.
- The recipe references the **product**, not a specific variant, because the
  size is picked per sale (requirement #4).

### saleItems gets ONE new optional field

```
saleItems.setGroupId?: string   // same value on all lines that came from one set instance
```

Purpose: group the 3 lines that belong to one sold set so returns, the edit
page, the invoice and reporting can treat them as a unit. It's a plain string
(e.g. a uuid generated per set added), NOT a foreign key, so it survives even
if the set recipe is later deactivated. Lines without it are normal singles.

No new `stockLedger` reason is needed: each component line writes the existing
`reason: "sale"` row, exactly like a single-item sale today.

### Checkout: how the set flows through (the safe part)

The client sends, per set instance, the chosen component variants + the setId.
Concretely, extend `checkoutLine` with two OPTIONAL fields:

```
checkoutLine = {
  variantId, qty, discount?,       // unchanged
  setId?: id("sets"),              // present => this line is part of a set
  setGroupId?: string,             // same on all lines of one set instance
}
```

Server logic when a line has `setId`:
1. Load the set recipe (`sets` + `setItems`). Reject if inactive/missing.
2. Verify the line's `variantId` belongs to one of the set's component products
   (the picked size of that component). Reject otherwise — the client can't
   smuggle an arbitrary variant in at a set price.
3. Set `unitPrice = setItems.setPrice` for that component (READ FROM THE DB,
   not the client). This is the ONLY change to price derivation.
4. Everything else is identical to a normal line: `unitCostSnapshot =
   weightedAvgCost(variant)`, one `sale` ledger row, oversell-checked.
5. Stamp `setGroupId` on the saleItem.

This keeps "the DB wins": the client sends the set id + which variants (intents),
the server derives the price from the recipe table just like it derives a
normal price from the product.

Rejected alternative (Option B): represent the set price as a per-line
`discount = normalPrice − setPrice`. Simpler (no unitPrice change) but the line
would still SHOW the normal price with a discount, per-item profit reads through
the discount term, and a set that costs MORE than the sum of items can't be
expressed. We prefer storing the real set price as `unitPrice`.

### Profit — no formula change

`buildDetail` already computes per line: `(unitPrice − unitCostSnapshot) × qty −
discount`, summed. With the set's `unitPrice` = set price and the component's
own `unitCostSnapshot`, the profit comes out correct with ZERO change:

Using the example (costs: shirt $4, tshirt $3, pants $3):
- Shirt line: 6 − 4 = $2
- T-shirt line: 3 − 3 = $0
- Pants line: 6 − 3 = $3
- Set profit = $5 = $15 set price − $10 total cost ✓

Product performance stays honest: each shirt/tshirt/pants shows its real units
and margin; sets can also be counted via `setGroupId`.

### Availability (display only)

Set sellable count = `min over components of floor(componentStock / qty)`.
Shown on the POS set card. Real oversell protection stays server-side per
component at checkout (unchanged `assertStockCovers`).

## UI changes

1. **Sets CRUD** (`/sets`): create/edit a set — name, optional photo, add
   components (pick product + qty + set price). Set total = sum shown live.
   Soft-delete only.
2. **POS "Add set" flow**: pick a set → a small dialog to choose each
   component's size (mix-and-match) → adds the component lines to the cart,
   tagged with one `setGroupId` and each carrying its set price (display). The
   cart shows them grouped under the set name with the set total.
3. **Invoice / detail / edit**: lines already render normally; optionally show
   a "Set: <name>" grouping header when `setGroupId` is present.

## What this touches (honest scope)

- Schema: 2 new tables + 1 optional `saleItems` field. No change to stockLedger.
- Checkout: the ONE price-derivation branch above + validation that the variant
  belongs to the set.
- Returns / saveEdit / delivery outcomes: work unchanged because set lines ARE
  normal sale lines. `setGroupId` is only used for grouping/display; if we want
  "return the whole set as one action" that's an extra convenience, not required
  for correctness.
- Reports: optional — count sets sold via `setGroupId`. Not required for v1.

## Explicitly OUT of scope for v1 (confirm)

- Set price varying by size (we assume flat per component).
- "Assemble stock into set" inventory (never — stock stays in components).
- Returning a whole set in one click (individual component returns work; the
  one-click set return is a later nicety).

## Decisions (signed off)

1. **Flexible recipe with per-component qty.** The owner defines any combo:
   1 shirt + 2 pants, or 1 shirt + 1 t-shirt + 1 pants, etc. The create-set
   screen has a qty box per component.
2. **Set price can be lower OR higher** than the sum of normal prices → we
   store the real set price as the line `unitPrice` (not a discount).
3. **Mix-and-match sizes** at checkout: the cashier picks each component's size
   (same or different), same price either way.
4. **Add-ons are free.** After a set, extra single items are just normal cart
   lines (normal price or discounted) — no special handling.
5. **Checkout UI = Option 2**: the set shows as a card in the POS grid; tapping
   it opens a size popup (one size picker per component unit, so a 2-pants set
   shows two pants rows), then adds all component lines at their set prices.
   The existing single-product tap-to-add grid is NOT modified.
6. **Returns v1 = per-component** (each set line returns like a normal line).
   One-click "return whole set" is a later nicety, not required for correctness.
