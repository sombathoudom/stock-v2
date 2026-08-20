<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# DolyOutfits POS — Product Spec & Task Roadmap

## Project overview

POS for an online clothing shop (DolyOutfits), but designed **generic**: any shop owner should be able to configure and use it — no hardcoded shop name, currency, or timezone.

- Stack: Next.js 16 + Convex + Better Auth (email/password — already integrated) + TanStack Table (one shared DataTable) + `@convex-dev/ratelimiter`. TanStack Query only if non-Convex fetching ever appears.
- Products have **sizes and optional colors**: one product = one design. If a product has no colors (e.g. a shirt defined only as M–3XL), its variants are **just sizes** — no color field. If it has colors, a variant is a size × color combo. Default sell price and reference cost are set once on the product and copied to all variants; any variant can override its own price or cost. Differences may be **per size, per color, or per individual size × color combo** — all supported. A bulk-apply tool sets one price across any selection (whole product, one size across all colors, one color across all sizes, or hand-picked combos), so owners only type what actually differs.
- **Delivery is an optional module** (shop setting). Owners who use delivery companies: each sale picks a company; the company's default fee (what the shop pays) is auto-filled per order and overridable; the fee charged to the customer is separate. **Delivery companies are contact records only** — they never log in, never use the app; they just receive the dropped packages. How the owner learns the outcome is up to them (a forwarded packaging photo in Telegram, a paper report, a phone call — the app assumes nothing). The owner marks every outcome in the app, so all inventory and order control stays 100% in the owner's hands. Owners without delivery companies skip the whole flow — sale has no company, no fees (in-store pickup or own delivery).
- **Orders come from the shop's sales pages** (online sellers typically run 3–4 pages). Every sale records its source page (sales channel), the staff member who created it, the customer, the delivery company, its own profit, and its paid/unpaid state — all on one order-detail screen with the full event history (cancelled, size exchanged, item changed, extra item added…).
- Responsive mobile-first: must work on phone (~390px), iPad (~768px), laptop (~1280px).
- **Reports are cash-basis**: money counts on the day it is RECEIVED, not the day the order was created. Order on 01-10-2026, delivered & paid 02-10-2026 → the money appears in the 02-10-2026 report.
- Money = integer **cents** everywhere (never floats). Dates = epoch ms; day boundaries computed in the shop timezone (default Asia/Phnom_Penh).
- **No online payment gateway for now** (skip Stripe). Payments are recorded manually by staff — cash, bank transfer, or other — at whatever moment money actually arrives. The separate `payments` row design keeps the door open for gateways later with no schema change.

## Core entities (Convex tables)

- `shop` — settings: name, logo (imageStorageId), address, currency (base currency, e.g. USD), exchange rate (owner-stored, e.g. `1 USD = 4000 riel` — checkout converts riel amounts entered by staff into the base currency using this rate; the converted result is overridable), timezone, low-stock thresholds, printer config (see T25). Single row; schema stays tenant-ready.
- `users` — staff linked to better-auth users: role `owner | staff` today. (Platform `superadmin` is deferred — it ships with multi-tenant later.)
- `categories` — product categories.
- `salesChannels` — the shop's selling pages: name, type (`facebook | instagram | tiktok | walk_in | custom`), active. Every sale has exactly one.
- `products` — name, description, defaultPrice, defaultCost (reference cost, used to prefill purchase cost), hasColors, imageStorageId? (product photo via Convex file storage), active.
- `productVariants` — one row per size × color combo: `{size, color?}`, optional `price` / `cost` overrides (fall back to product defaults), SKU.
- `suppliers` — name, phone, notes.
- `deliveryCompanies` — name, phone, defaultFee (what the shop pays per handled order), active. Contact record only — companies are never app users.
- `purchases` — supplier, code, status `draft | received`, receivedAt, notes. **Editable at any time.**
- `purchaseItems` — line: variantId, qty, unitCost. Stock enters via ledger rows owned by this line.
- `stockLedger` — **IMMUTABLE** movement rows: `{variantId, delta, reason: purchase | sale | return | exchange_out | exchange_in | cancel | adjustment | stocktake, purchaseItemId?, saleItemId?, userId, ts, note}`. Stock = `sum(delta)` per variant — no running totals stored, computed by aggregation.
- `customers` — name, phone (**unique**, normalized), address, notes.
- `sales` — order: code (e.g. `20261001-001`), customerId, salesChannelId (which page it came from), deliveryCompanyId? (null when delivery module off or self-delivery), status `draft | pending | confirmed | packed | delivering | delivered | partially_delivered | cancelled`, deliveryFee (charged to customer), deliveryCost (paid to delivery company; default from company, overridable per order), discount, userId (staff who created the order), createdAt, deliveredAt, chargeDeliveryOnCancel? (the trip happened but the customer refused the goods — see T12). Order detail computes **per-order profit** and paid/unpaid on read. **Drafts touch no stock** — deduction happens only when the order is confirmed; POS checkout creates a confirmed sale directly. `pending` is a post-confirm regression (reachable only from confirmed, selectable via Update-status / Sale edit): stock stays out while the order waits, payments are accepted, and from pending any later stage is reachable.
- `saleItems` — line: variantId, unitPrice, qtyOrdered, qtyDelivered, qtyCancelled, qtyReturned, discount (per-item, cents, optional), unitCostSnapshot (cost at sale time). Line-level status so ONE order can mix delivered / cancelled / exchanged.
- `payments` — `{saleId, amount, receivedAt, receivedDay, method: cash | bank_transfer | other | refund, userId}`. Manual staff entry only (no gateway). Many per sale (partial payments); remaining = order total − sum(payments). **Refunds are payments with a negative amount** (`method: refund`) — money out lives in the same table, so paid/remaining and daily totals never drift. **Daily report = payments by receivedAt day** (money in minus money out); `receivedDay` is an indexed `YYYY-MM-DD` string (shop tz) so daily reports never full-scan.
- `expenses` — `{amount, category, spentAt, spentDay, note, userId}`. Every spend (rent, materials, delivery-company payouts not tied to a sale, etc.) is a row; daily P/L subtracts expenses spent that day. `spentDay` indexed like `receivedDay`.
- `saleEvents` — immutable per-sale history (status changes, edits, exchanges) for audit.

## Non-negotiable rules (these solve the reported problems)

1. **Stock is a ledger, never a counter.** Every in/out is a `stockLedger` row. "System says 1 qty but real stock is 0" becomes traceable: pull a variant's movement history and see exactly where every piece went (which sale, which purchase, which adjustment). No code may mutate a qty field directly. Quantities are pure ledger sums (`sum(delta)`) — no costing method involved; stock can't vanish silently because every piece's movement is a row. Inventory control is fully in the owner's hands: only signed-in staff move stock through the app — no external party (delivery companies, etc.) has any access.
2. **Revenue is recognized on payment date.** Payments are separate rows recorded manually by staff (cash / bank transfer / other — no online gateway yet); a sale can be partially paid, and the remaining amount is always visible. Daily P/L = payments received that day − expenses spent that day − COGS of paid items. Monthly/yearly are aggregates of the same.
3. **Profit uses per-purchase cost.** The same shirt can cost differently across purchases. Each `saleItem` snapshots `unitCostSnapshot` (weighted-average cost of the variant at sale time). **Costing uses weighted average, NOT FIFO/LIFO** — one average cost per variant, recalculated as purchases land; simple for the owner to understand and stable when a purchase is edited later (past sales keep their snapshot, so history never shifts). Profit = Σ(salePrice − unitCost) − discounts + deliveryFee − deliveryCost − expenses. **Every order shows its own profit and paid/unpaid state at a glance**: order profit = Σ(item revenue − item cost) − discount + deliveryFee − deliveryCost; paid = sum(payments) vs order total.
4. **Sales are flexible per line.** Delivery man arrives and customer takes half → mark delivered qty on those lines, cancel the rest (stock flows back via ledger). Before delivery, every change (size exchange, changed item, extra/removed item, quantity up/down) goes through the **one Edit Sale page** (`sales.saveEdit`, T12) — it applies the diff as ledger rows + `saleEvents` in ONE transaction, never a silent edit. After delivery, a size exchange is a NEW event (`exchange_out` old size + `exchange_in` new size); a changed item or an extra/removed item is likewise a new event with ledger rows. Every change appends `saleEvents`.
5. **Purchases are editable and stock recalculates itself.** Editing a purchaseItem rewrites only that line's ledger entries; stock is aggregation, so nothing else needs recalculating.
6. **Fast customer lookup with dedupe.** Unique index on normalized phone. On customer create: search by phone (and similar name) → if match, alert "customer already exists" with options → pick existing or force-create.
7. **Expenses are first-class.** Tracked per day with categories; delivery income vs delivery cost are per-sale fields and shown separately in reports.
8. **Audit everything.** Ledger + saleEvents + userId/ts on every write. "Where did this stock go?" must always be answerable.
9. **Delivery reconciliation is the evening ritual, and it assumes no report format.** A reconciliation screen groups today's delivering orders by delivery company; the owner marks each order's outcome (delivered / partially delivered / returned / cancelled) from whatever confirmation they got — a forwarded packaging photo in Telegram, a paper list, a phone call, or nothing yet. Orders stay in "delivering" until marked. Summary per company: orders handled, delivered count, returns, cancellations, and the total fee payable to that company (editable per order before it becomes an expense). Outcomes drive stock flow-back and paid/unpaid tracking. Owners without a delivery flow never see this screen.
10. **Nothing with history is ever hard-deleted.** Products, customers, suppliers, channels soft-delete (`active: false` — hidden, history intact). Sales and purchases are never deletable — only cancellable. Anything that moved stock can never disappear.

## Stock & calculation integrity — how the app guarantees this

**Stock can never go missing:**
- **One source of truth**: `stockLedger`. Stock = `sum(delta)` computed fresh on every read — there is no stored qty field anywhere that can drift, and no code may write a quantity outside the ledger.
- **Atomic writes**: every stock-changing action is ONE Convex transaction — the business write (sale / purchase / return / exchange…) + its ledger rows + saleEvents all succeed or fail together. A crash or error can never leave a half-applied movement.
- **Oversell is impossible**: before deducting, the mutation re-checks current stock in the same transaction and rejects the write if it would go negative.
- **Every row is signed**: `userId` + `ts` + `reason` + links back to the sale/purchase that caused it. "Where did this piece go?" always resolves to an order, a purchase, or a stocktake.

**Calculations can never be wrong:**
- **No stored totals**: order total, profit, paid/remaining, stock, and average cost are all derived on read from their source rows (`saleItems`, `payments`, `stockLedger`) — there is nothing cached that can go stale or drift.
- **Server re-derives everything**: the client sends only ids, quantities, and intents; every price, cost, total, and discount is recomputed from the DB. A tampered value from the frontend is ignored — the DB wins.
- **Money is integer cents end-to-end** — no floats, no rounding drift.
- **Average cost recalculates** per variant as purchases land; each sale snapshots it at sale time, so historical profit is frozen and editing an old purchase only affects ledger rows going forward.
- **Verification ships with the system**: per-variant movement history (T6), stock movement report (T21), and stocktake (T22) — the physical count vs system check that catches real-world losses (theft, damage, miscounts) and records them as signed adjustments.

## Dashboard (mobile-first)

- Today: packs shipped, paid amount, unpaid amount, cancelled lines, exchange count.
- Unpaid list (delivered, not fully paid) with customer phone.
- Low-stock alerts.
- Daily P/L card: profit or loss for today with breakdown.
- Quick actions: New Sale, New Purchase, New Expense, Stock Adjustment, Stocktake, Delivery Report (evening reconciliation).

## UI/UX design conventions (every screen follows these)

- **Theme & colors**: the shadcn/ui preset is ALREADY installed (`base-vega` style, zinc base — see `components.json`). NEVER hardcode colors in components — always use the CSS variables configured in `src/app/globals.css` (shadcn tokens: `bg-background`, `text-foreground`, `border`, `primary`, `muted`, `destructive`…). Changing the preset restyles the whole app automatically. Icons come from the preset's icon library (**hugeicons**) — no ad-hoc SVGs.
- **Navigation shell (important)**: collapsible sidebar on desktop, bottom navigation bar on mobile (thumb-reachable) — both rendered from the same `src/config/nav.ts`. **The active page is always highlighted** — the sidebar item and the bottom-nav icon/label show a clear active state, so the user always knows where they are. Fully responsive at 390 / 768 / 1280px.
- **Page header row**: feature icon + feature name on the left, with the primary action button right there — e.g. `+ Add Customer` (shadcn Button, primary variant, Plus icon). On the right side of the same row: the filter area (search by name, phone, …).
- **Tables**: always bordered; TanStack Table with column reordering enabled on the chosen columns; pagination at the **bottom** with a page-size selector of **20 / 50 / 100**.
- **Create/update pages**: the submit button sits at the **bottom left**; next to it the cancel button in a colored (destructive/secondary) variant **with an icon**.
- **State memory**: ALL UI state persists in the browser (localStorage via a shared `usePersistentState` hook) — filters, page size, column order/visibility survive reloads.
- Reusable pieces: one `PageHeader` component, one `DataTable` (already standard), one `usePersistentState` hook in `src/hooks/`.
- **Plain-language labels**: everything a user reads uses simple everyday shop words — never technical terms. Examples: stock movements show as "Stock in / Stock out" (never "ledger"), cost at sale shows as "Cost price" (never "unitCostSnapshot" / "COGS"), remaining balance shows as "Still owed" (never "unsettled receivable"), the evening screen says "Mark delivery outcome" (never "reconciliation"). Technical names live only in code and developer docs. All user-facing strings live in ONE labels module (`src/config/labels.ts`) so wording is tuned in one place — and messages are shown in Khmer or English per the user's language.

## Responsive layout design (desktop / tablet / phone)

**Breakpoints**: phone < 768, tablet 768–1023, desktop ≥ 1024 (Tailwind defaults; 390 / 768 / 1280 are the verification widths).

**App shell**
- Desktop (≥1024): fixed left sidebar (~240px, collapsible to icon-only), content max-w-7xl centered with generous padding.
- Tablet (768–1023): icon-only sidebar by default, expandable.
- Phone (<768): no sidebar — top app bar with a menu button that opens a Sheet drawer containing the full nav, plus a fixed **bottom nav** (max 5–7 main items: Home, Sales, Products, Stock, Reports, + "More" sheet) with safe-area padding. Thumb-reachable, one-hand operation.

**Page header**
- Desktop/tablet: icon + title + primary action on the left, filters inline on the right.
- Phone: title + primary action on one row; filters collapse behind a "Filter" button that opens a Sheet; active filters show as removable chips.

**Tables (one shared DataTable)**
- Desktop/tablet: full table with column reordering, bordered, pagination at the bottom (20 / 50 / 100).
- Phone: the DataTable switches to a **card list** — primary columns (name, phone, total, status…) on the card, the rest inside an expandable section; tapping a card opens detail/edit; compact pagination stays at the bottom.

**Forms (create/update)**
- Desktop: 2-column grid for related fields (name + phone…), full-width textareas; submit at the bottom-left + colored cancel with icon beside it, in a sticky footer bar.
- Phone: single column stacked; every input ≥ 44px tall; money/qty inputs use the numeric keyboard (`inputMode`); sticky footer with submit + cancel always visible while scrolling.

**POS checkout (the phone-heavy screen)**
- Phone: one step at a time (7-step stepper) with a progress indicator; a sticky bottom bar always shows the running total + "Next"/"Done"; qty controls are big + / − buttons; customer/variant pickers open as bottom Sheets.
- Desktop: 2-pane layout — items on the left, live cart summary on the right — same steps underneath.

**Phone ergonomics (every screen)**
- Minimum 44×44px tap targets; dialogs become bottom Sheets on phone; no hover-only actions (everything reachable by tap); native date pickers; safe-area insets respected.

## Reports

- **Daily / Monthly / Yearly P/L**: payments received − COGS of paid items − discounts − expenses, by category; delivery income vs delivery cost separate.
- **Sales by channel (page)**: orders, revenue, and profit per page — which page brings the most money.
- **Product performance**: units sold per size; returns/exchanges per size (guides which sizes to reorder).
- **Stock movement report** per variant, filterable by date range + reason.

## Task roadmap

> Checked tasks are implemented (routes + Convex functions + components in place). T27 is the only remaining item.

**Phase 1 — Foundation & catalog**
- [x] T1 `shop` settings table + UI (name, **logo upload**, address, currency, **exchange rate**, timezone, delivery module toggle, **printer settings**); `users` with role
- [x] T2 Categories CRUD (responsive)
- [x] T3 Products + variants CRUD: size list, optional color list, default price/cost copied to all variants, per-variant override (with bulk-apply so shared prices are entered once), **image upload** (Convex file storage, preview in the form)

**Phase 2 — Stock core**
- [x] T4 Suppliers CRUD
- [x] T5 Purchases + purchaseItems (draft → received), editable anytime, ledger entries per line. **Purchase UI must be clean and easy when adding many items**: supplier combobox at top (search + quick-add supplier), then line-based item entry — pick product → pick size (× color when the product has colors) → qty → unit cost (prefilled from product defaultCost, editable per line); lines render in a summary table with per-line remove/edit, and live totals (items, total cost) always visible; works on mobile
- [x] T6 `stockLedger` + aggregation queries + stock page (per variant with full movement history + **integrity check**: re-derive stock from the ledger and compare against recorded stocktakes)

**Phase 3 — Sales & payments**
- [x] T7 Customers CRUD + dedupe lookup on create (phone/name alert)
- [x] T8 Sales channels CRUD (the shop's 3–4 pages: Facebook/IG/TikTok/walk-in)
- [x] T9 Delivery companies CRUD (optional module: names, phones, default fees)
- [x] T10 POS sale screen — checkout flow in this order: ① add items (choose item, qty, optional per-item discount; the same item added twice stays as two separate lines — never merged) ② create or pick customer (dedupe alert) ③ pick channel/page (required) ④ pick delivery company with fee auto-fill — the company's default fee lands in the shipping-fee input (charged to the customer, overridable); what the shop pays the company is the company's own cost field ⑤ one grid of order-level amounts: order discount + **shipping fee** side by side (the fee stands on its own even when no company is picked — self-delivery still charges shipping) ⑥ payment: mark paid/unpaid, enter amount received, show remaining ⑦ **print invoice** → done. Server re-derives all prices/costs/totals; checkout → sale + saleItems + ledger deduction with cost snapshot
- [x] T11 Payments: receive full/partial (manual cash/bank/other), payment history, remaining + unpaid tracking. Plus from the sales list: **"Create a payment" dialog** (shows the still-owed amount, backdated received date, live change when the amount entered is more than owed — server clamps to the remaining) and a **"Show payment" history dialog**
- [x] T12 Order lifecycle + **order detail page**: status transitions with saleEvents; list with filters (today, unpaid, delivering, delivered, by page, **payment status**, **customer**, **From/To date range**); detail shows channel, created-by, customer, delivery company, **per-order profit**, **paid/unpaid state**, and full event history. List extras: **summary cards** (Sales / Total / Paid / Due — same filters as the rows), a **single-line compact filter bar** with a **Clear filters** button (scrolls sideways on phone), a **payment-status column**, and a **row-actions menu** per order (Edit sale / Update status / Sale detail / Sale return / Show payment / Create a payment / Invoice / Cancel sale). **Update status lists every delivery stage** (confirmed → packed → out for delivery → partially delivered → delivered) with the current one marked and impossible steps greyed out, so stages can be skipped forward (a self-delivered order jumps straight to delivered) — but a delivered order never re-opens: its only correction is back to partially delivered. **A confirmed order can also be marked pending** ("wait before processing"): stock stays out (already deducted at checkout), payments are accepted, and from pending any later stage is reachable, including back to confirmed. **Edit sale is a full page** (`/sales/<uuid>/edit`, breadcrumb + cards): an **editable items table** (add via a name/SKU search, change quantity, unit price or per-item discount inline, remove a line, or swap an undelivered line to another size/color) alongside the order fields and an **order-status dropdown**, all saved by ONE `sales.saveEdit` mutation = ONE transaction. Nothing touches stock until Save; then the diff applies as ledger rows — a raised quantity deducts only the extra, a lowered one returns only the difference, a removed line returns its whole billed quantity, and any failure rolls the entire save back. A line can never drop below what was already delivered (that's the return flow's job); a swap writes `exchange_out` + `exchange_in` rows and re-prices/re-costs the line from the new variant. Every save bumps the order's `editedVersion` counter — a save from a stale window is refused (`STALE_EDIT`) and a retried save re-measures to zero deltas (a clean no-op), so double-clicks and concurrent windows never duplicate ledger rows or events

**Phase 4 — Real-world flexibility**
- [x] T13 Per-line delivered/cancelled/partial handling (adjust qty at the door) with stock flow-back
- [x] T14 Order adjustments: size exchange, change item, add/remove extra items — all through the **Edit Sale page** (`sales.saveEdit`), the one adjustment workflow (consolidated: the legacy per-action swap/add/remove dialogs and mutations were removed). Every change appends saleEvents + ledger rows (never silent edits); a swap writes `exchange_out` (old variant) + `exchange_in` (new variant) rows and re-prices/re-costs the line from the new variant, all in ONE transaction. An exchange that needs a second delivery run carries an optional **extra shipping charge for the second trip** — it is ADDED to the order's shipping fee (audited as a fee edit), so the trip bills the customer without a separate edit
- [x] T15 Sale returns (full/partial) with refund handling — a refund is a negative-amount `payments` row (`method: refund`); stock flows back via `return` ledger rows, and paid/remaining + daily reports recompute automatically. Multi-line return dialog with optional refund is also on the sales list
- [x] T16 Sale edit history viewer (who changed what, when — events show old → new values, e.g. price $6 → $5.50). The **Edit sale** page writes one `sale_edited` event per changed field (customer / channel / delivery company / fees / discount / note / per-line price / per-line discount) plus `item_added` / `item_removed` / `item_qty_changed` / `item_swapped` per changed line
- [x] T17 Evening delivery reconciliation: group today's delivering orders by company, mark outcome per order (delivered / partial / returned / cancelled), per-company summary (handled, delivered, returns, cancellations, fee payable with per-order adjustment); each order can have a **packaging photo** attached (same image storage as products) shown next to "mark outcome". Returned / cancelled outcomes (and the plain Cancel sale action) offer **"Customer still pays shipping"**: the goods flow back and drop off the bill, but the shipping fee stays owed, the order shows Unpaid, and a payment can be collected against it — for the trip that really happened

**Phase 5 — Expenses & reports**
- [x] T18 Expenses CRUD + categories
- [x] T19 Daily P/L (cash-basis) + monthly/yearly reports
- [x] T20 Dashboard KPIs (paid/unpaid/packs/cancelled/exchanges/low stock) + unpaid list with one-tap **payment reminder** (opens WhatsApp/Telegram with a pre-filled "still owed $X" message per customer)
- [x] T21 Stock movement report + per-purchase stock trace + sales by channel

**Phase 6 — Extras (good for any owner)**
- [x] T22 Stock adjustments + stocktake: quick manual in/out per variant with reason + note (damaged, found, giveaway…) and full stocktake (count vs system) — both write `adjustment` / `stocktake` ledger rows, never direct qty edits
- [x] T23 Low-stock alerts
- [x] T24 CSV export (reports, stock) + one-click full JSON backup of all tables (business data safety)
- [x] T25 Receipt/invoice re-print from order detail; print formats: **80×80mm thermal receipt** (checkout — first print ships with T10) + **80×80 package label** (customer name, phone, address, order code — for packages handed to delivery companies) + A5 delivery invoice. **Printing stack**: ESC/POS bytes via `esc-pos-encoder`; USB printers via WebUSB (`navigator.usb`, no driver install); USB / network / **wireless printers** via QZ Tray (desktop bridge) or direct network IP; **auto-print** after checkout with no browser print dialog; printer choice + connection settings saved per shop (in `shop` settings) with a test-print button; per-printer assignment (thermal 80mm vs A4/A5)
- [x] T26 Roles/permissions (owner vs staff)
- [ ] T27 Customer credit ledger (debt per customer)

## Extra feature ideas (adopt when needed)

- **Digital menu / product catalog**: shareable or QR-scannable product showcase for walk-in shops, with **custom menu layouts** (grouping, featured items, ordering) — reads from the same products/variants tables, so no separate catalog to maintain.
- **Preorder management**: take orders (with optional deposit, recorded as a normal `payments` row) for items not yet in stock; link preorders to incoming purchases; convert to a normal sale automatically once stock lands.
- **Telegram notifications**: order created / status changed notifications to the owner's Telegram group, plus the delivery-reconciliation photo matching from T17.
- **Advanced reports**: best-seller + size-popularity analytics, profit by product / category / customer, dead-stock report, customer lifetime value.
- **Printing**: auto-print **80×80mm thermal receipts** at checkout via `esc-pos-encoder` + WebUSB / QZ Tray / network printers — USB and wireless both supported; multiple printers with per-printer assignment.
- Barcode/SKU scanning; supplier debt ledger; delivery fee per package / weight tier; WhatsApp/Telegram order links; data export/backup; multi-tenant SaaS later (schema is already tenant-ready via the `shop` row).

## Engineering standards (code quality, security, performance)

**Architecture**
- **1 task = 1 function.** Convex functions stay small: authenticate → validate (DTO) → call a service helper → return. No mega-functions.
- **Layering**: page/route handler → client hook → Convex function → service util. **DTOs** are the `v.object` validators (args + `returns:`) shared from one types module (`convex/types.ts`), so client and server use identical shapes. No `any`, no unvalidated client input.
- **Forms**: React Hook Form + Zod (`zodResolver`) for every form; reusable field components (`FormInput`, `FormSelect`, `FormCombobox`, `FormDate`) built ONCE on shadcn/ui + RHF so no form repeats field logic. Zod schemas give fast client-side UX validation; the server always re-validates with Convex `v.*` validators — the frontend is never trusted.
- **Navigation in one place**: all navbar/sidebar links, labels, icons, and required roles live in ONE config module (`src/config/nav.ts`); the navbar renders from it — adding a page never means editing nav JSX.
- **Reusable UI**: every list/table uses ONE shared `DataTable` built on TanStack Table (server-side pagination, sorting, mobile-friendly). Form fields, dialogs, cards, and layout primitives are shared components. **All UI uses shadcn/ui components** (button, input, dialog, select, card, sheet, table…) — never ad-hoc raw elements where a shadcn primitive exists. Global helpers live in `src/lib/utils.ts` (or `src/lib/`); custom hooks live in `src/hooks/`.
- **TanStack Query**: do NOT use it for Convex data — Convex's reactive hooks already handle caching, dedupe, and invalidation. Add it only if non-Convex fetching ever appears.
- **Error handling**: handle errors carefully everywhere — no silent failures. Every query/mutation call catches errors; unexpected failures pop an alert via shadcn's `sonner` toast through one shared helper (`toastError(err)` in `src/lib/utils.ts`) that maps known Convex errors to friendly Khmer/English messages. Zod/RHF field errors render inline under the field. Never show raw stack traces or internal ids to users — log the full error server-side (`console.error`) for debugging, show the user a short actionable message.
- **State management**: NO global state library (no Redux/Zustand/Jotai). Convex reactive hooks ARE the data state layer — server state stays fresh and consistent across devices automatically. UI preferences persist via `usePersistentState` (localStorage). Transient UI (dialogs, form drafts, the checkout cart) is local component state — the POS cart gets one `useCheckoutCart` hook. Shared reads like current user / shop settings are simple `useCurrentUser()` / `useShop()` Convex query hooks. A client store is added only if genuine non-Convex state ever appears.
- **Professional naming & structure**: strict TypeScript everywhere (no `any` outside documented casts). kebab-case files (`product-form.tsx`, `use-customers.ts`), PascalCase components, camelCase functions/hooks (`use`-prefixed), descriptive names only. Folders: `src/components/ui` (shadcn primitives), `src/components/features/<feature>` (feature components), `src/hooks`, `src/lib`, `src/config`; Convex: `convex/<feature>.ts` per domain + `convex/types.ts` (shared DTOs) + `convex/helpers.ts` (service functions). Every module has one clear, discoverable responsibility — a new developer (or the owner) can find anything by its name.

**Data access**
- **No raw queries, ever.** Convex data goes only through the typed generated API (`convex/_generated/api`). If a SQL database is ever introduced, use an ORM (Prisma/Drizzle) — never raw SQL.
- **Always paginate.** Every list query uses `paginationOpts` server-side, including all DataTables.
- **Always index.** Every table gets indexes for its real access patterns: ledger by `(variantId, ts)`, saleItems/payments/saleEvents by `saleId`, customers by normalized phone, sales by day/channel/company, payments by `receivedDay`, expenses by `spentDay`. Daily/monthly reports must hit indexes, never full-scan.

**Security**
- **Never trust user input, never trust the frontend.** The client sends only ids + quantities + intents; the server re-derives every business value from the database — prices, costs, totals, discounts, stock availability, order totals. All input passes validators that strip unknown fields; any value that matters is recomputed server-side. Frontend checks are UX only.
- **Server-side auth on every Convex function** via a `requireUser(ctx)` helper (throws when unauthenticated) plus role checks for owner-only actions. Hiding buttons in the UI is UX, not security.
- **Data privacy / tenant scoping**: every read and write is scoped to the current user's shop — staff only ever see their own shop's rows; no query crosses shops. Today's roles are `owner` and `staff` only; a platform **superadmin** (who can view across shops) is deferred until multi-tenant lands. The `shop` row stays tenant-ready for it.
- **Credentials never reach the client.** Auth tokens/cookies are handled server-side (better-auth + getToken); the client only ever receives the safe profile from `getCurrentUser` (id, name, email, role). Nothing else from the session.
- **IDs**: Convex `_id`s are random UUIDs — use them as the public identifiers. Never expose sequential/enumerable ids; human-friendly codes (e.g. order `20261001-001`) are display labels, never access keys. **Every route carries only the UUID** — detail, edit, and any route referencing a record (e.g. `/customers/<uuid>`, `/customers/<uuid>/edit`); the backend resolves it with `ctx.db.get(uuid)` — there is no enumerable lookup to tamper with, so changing an id in the URL can never reveal another record.
- **Rate limiting**: `@convex-dev/ratelimiter` on auth endpoints and any public HTTP routes.
- **`.env` hygiene**: `.env*` is gitignored (verify it stays that way); secrets are set only on the deployment (see the anonymous-deployment note); `NEXT_PUBLIC_*` contains only safe URLs.

**Performance / budget**
- Small indexed reads; one aggregation per request; avoid N+1 (batch by indexed `saleId`/`variantId` queries).
- Prefer queries over mutations where reads suffice; keep the client bundle lean (server components by default, `"use client"` only where needed).
- Clean, small, commented-where-needed code — the server layer must be easy for another developer (or the owner) to read and cheap to run.

## Conventions (agent instructions)

- Convex: object-form functions with `returns:` validators on every function EXCEPT `convex/auth.ts:getCurrentUser` (inferred type from the component's user schema; documented exception — convex-lint will flag it).
- Money: integer cents; format only in the UI.
- Dates: epoch ms; day boundaries in the shop timezone.
- Never mutate stock fields directly — always write ledger rows.
- Responsive: mobile-first Tailwind; verify layouts at 390 / 768 / 1280px before finishing any UI task.
- Before each task, read the relevant guide in `node_modules/next/dist/docs/` (APIs differ from older Next.js).
- Tests: `npm test` (Vitest + `convex-test`, config in `vitest.config.mts`, specs in `convex/*.test.ts`). They run Convex functions in-memory — no deployment, and the local backend's data is never touched. Sign-in is the only thing stubbed (`vi.mock("./auth")` replaces the better-auth component, which has no in-memory equivalent); `requireUser` and every business rule below it run for real against a seeded `users` row.
- This project runs an **anonymous local Convex deployment**: `.env.local` vars do NOT reach the Convex runtime, and `npx convex env set` fails (needs cloud login). Set deployment env vars by POSTing to `http://127.0.0.1:3210/api/update_environment_variables` with header `Authorization: Convex <adminKey>` (adminKey in `.convex/local/default/config.json`) and body `{"changes":[{"name":"X","value":"Y"}]}`. Vars persist in the backend's sqlite and survive restarts.
