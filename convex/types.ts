import { v } from "convex/values";

// Shared DTO validators — client and server use identical shapes.
// Money = integer cents, always validated for integer-ness + bounds in service
// helpers (see helpers.ts), never trusted from the wire.

/** Integer cents. Service helpers assert Number.isInteger + sane bounds. */
export const money = v.number();

/** Integer quantity, ≥ 1 or ≥ 0 depending on context (asserted in services). */
export const qty = v.number();

// --- Enum unions (kept in sync with schema.ts) ---

export const userRole = v.union(v.literal("owner"), v.literal("staff"));

export const channelType = v.union(
  v.literal("facebook"),
  v.literal("instagram"),
  v.literal("tiktok"),
  v.literal("walk_in"),
  v.literal("custom")
);

export const purchaseStatus = v.union(v.literal("draft"), v.literal("received"));

export const saleStatus = v.union(
  v.literal("draft"),
  // Pending: a post-confirm regression — stock is already out (deducted at
  // checkout) and the order waits before processing; from pending any stage
  // is reachable.
  v.literal("pending"),
  v.literal("confirmed"),
  v.literal("packed"),
  v.literal("delivering"),
  v.literal("delivered"),
  v.literal("partially_delivered"),
  v.literal("cancelled")
);

export const ledgerReason = v.union(
  v.literal("purchase"),
  v.literal("sale"),
  v.literal("return"),
  v.literal("exchange_out"),
  v.literal("exchange_in"),
  v.literal("cancel"),
  v.literal("adjustment"),
  v.literal("stocktake")
);

export const paymentMethod = v.union(
  v.literal("cash"),
  v.literal("bank_transfer"),
  v.literal("other"),
  v.literal("refund")
);

export const printerType = v.union(
  v.literal("webusb"),
  v.literal("qz_tray"),
  v.literal("network")
);

// --- Document DTOs (used as `returns:` validators) ---

export const shopDoc = v.object({
  _id: v.id("shop"),
  _creationTime: v.number(),
  name: v.string(),
  logoStorageId: v.optional(v.id("_storage")),
  address: v.optional(v.string()),
  phone: v.optional(v.string()),
  currency: v.string(),
  exchangeRate: v.number(),
  timezone: v.string(),
  deliveryEnabled: v.boolean(),
  lowStockThreshold: v.optional(v.number()),
  language: v.union(v.literal("en"), v.literal("km")),
  printerConfig: v.optional(
    v.object({
      type: printerType,
      vendorId: v.optional(v.number()),
      productId: v.optional(v.number()),
      // T25 — QZ Tray printer name + public signing certificate (see schema.ts).
      qzPrinterName: v.optional(v.string()),
      qzCert: v.optional(v.string()),
      networkHost: v.optional(v.string()),
      networkPort: v.optional(v.number()),
    })
  ),
  defaultCustomerId: v.optional(v.id("customers")),
});

export const userDoc = v.object({
  _id: v.id("users"),
  _creationTime: v.number(),
  authUserId: v.string(),
  name: v.string(),
  email: v.string(),
  role: userRole,
  phone: v.optional(v.string()),
  active: v.boolean(),
});

export const categoryDoc = v.object({
  _id: v.id("categories"),
  _creationTime: v.number(),
  name: v.string(),
  nameLower: v.string(),
  active: v.boolean(),
});

export const salesChannelDoc = v.object({
  _id: v.id("salesChannels"),
  _creationTime: v.number(),
  name: v.string(),
  nameLower: v.string(),
  type: channelType,
  active: v.boolean(),
});

export const productDoc = v.object({
  _id: v.id("products"),
  _creationTime: v.number(),
  name: v.string(),
  nameLower: v.string(),
  description: v.optional(v.string()),
  code: v.optional(v.string()),
  categoryId: v.optional(v.id("categories")),
  defaultPrice: v.number(),
  defaultCost: v.number(),
  hasColors: v.boolean(),
  sizes: v.array(v.string()),
  colors: v.array(v.string()),
  imageStorageId: v.optional(v.id("_storage")),
  active: v.boolean(),
});

export const productVariantDoc = v.object({
  _id: v.id("productVariants"),
  _creationTime: v.number(),
  productId: v.id("products"),
  size: v.string(),
  color: v.optional(v.string()),
  price: v.optional(v.number()),
  cost: v.optional(v.number()),
  sku: v.optional(v.string()),
  active: v.boolean(),
});

export const supplierDoc = v.object({
  _id: v.id("suppliers"),
  _creationTime: v.number(),
  name: v.string(),
  nameLower: v.string(),
  phone: v.optional(v.string()),
  notes: v.optional(v.string()),
  active: v.boolean(),
});

export const deliveryCompanyDoc = v.object({
  _id: v.id("deliveryCompanies"),
  _creationTime: v.number(),
  name: v.string(),
  nameLower: v.string(),
  phone: v.optional(v.string()),
  defaultFee: v.number(),
  imageStorageId: v.optional(v.id("_storage")),
  active: v.boolean(),
});

export const purchaseDoc = v.object({
  _id: v.id("purchases"),
  _creationTime: v.number(),
  supplierId: v.id("suppliers"),
  code: v.string(),
  status: purchaseStatus,
  purchasedAt: v.number(), // business date, epoch ms
  receivedAt: v.optional(v.number()), // arrival date — present = stock is in
  notes: v.optional(v.string()),
  deliveryCost: v.optional(v.number()), // what transport cost us, integer cents
  otherCost: v.optional(v.number()), // any other purchase cost, integer cents
  userId: v.id("users"),
  createdAt: v.number(),
});

export const purchaseItemDoc = v.object({
  _id: v.id("purchaseItems"),
  _creationTime: v.number(),
  purchaseId: v.id("purchases"),
  variantId: v.id("productVariants"),
  qty: v.number(),
  unitCost: v.number(),
});

// One purchase list row: the purchase + supplier name + aggregate line stats
// (item count = Σ qty, grand total = Σ qty × unitCost + deliveryCost + otherCost,
// integer cents).
export const purchaseListItem = v.object({
  purchase: purchaseDoc,
  supplierName: v.string(),
  itemCount: v.number(),
  totalCost: v.number(),
});

// Purchase detail: the purchase + its supplier + every line joined with the
// variant and product it points at (deduped reads server-side).
export const purchaseDetail = v.object({
  purchase: purchaseDoc,
  supplier: supplierDoc,
  items: v.array(
    v.object({
      item: purchaseItemDoc,
      variant: productVariantDoc,
      product: productDoc,
    })
  ),
});

export const stockLedgerDoc = v.object({
  _id: v.id("stockLedger"),
  _creationTime: v.number(),
  variantId: v.id("productVariants"),
  delta: v.number(),
  reason: ledgerReason,
  purchaseItemId: v.optional(v.id("purchaseItems")),
  saleItemId: v.optional(v.id("saleItems")),
  userId: v.id("users"),
  ts: v.number(),
  note: v.optional(v.string()),
});

// One variant with its computed stock: sum of ledger deltas. No stored
// totals anywhere — stock is always the aggregation (AGENTS.md rule #1).
// lastMovementTs is the newest ledger ts — the UI's "Last movement" /
// "Last updated" (products and variants have no updatedAt field, so the
// newest stock movement is the honest "when did this change" value; absent
// when the variant has never moved).
export const stockVariantQty = v.object({
  variant: productVariantDoc,
  qty: v.number(),
  lastMovementTs: v.optional(v.number()),
});

// One stock list row: a product with every variant and its computed stock.
export const stockListItem = v.object({
  product: productDoc,
  variants: v.array(stockVariantQty),
});

// One stock movement history row: the ledger row + the staff name who made
// it + the stock balance AFTER the movement + the order/purchase the row
// belongs to. Reference is structured ({kind, code}) so the client can
// localize "Order #1042" / "PO #208" through the labels module; it is
// absent for adjustments, stocktakes and rows without a linked document.
/** Order/PO reference on a movement row. Ids are Convex UUIDs — they are
 * the app's public route keys ("every route carries only the UUID"), never
 * enumerable numbers. `unitCost` is owner-only (staff never see costs). */
export const ledgerHistoryReference = v.object({
  kind: v.union(v.literal("order"), v.literal("po")),
  code: v.string(),
  saleId: v.optional(v.id("sales")),
  purchaseId: v.optional(v.id("purchases")),
  customerName: v.optional(v.string()),
  channelName: v.optional(v.string()),
  supplierName: v.optional(v.string()),
  unitCost: v.optional(v.number()),
});

/** Range summary for the movement viewer — derived fresh from the immutable
 * ledger, never stored: opening = Σ deltas before the range (0 when no From
 * filter), in/out = positive/negative sums inside the range, closing =
 * opening + in − out (equals current ledger stock when no filters). */
export const ledgerRangeSummary = v.object({
  opening: v.number(),
  in: v.number(),
  out: v.number(),
  closing: v.number(),
});

export const ledgerHistoryItem = v.object({
  row: stockLedgerDoc,
  userName: v.string(),
  balance: v.number(),
  reference: v.optional(ledgerHistoryReference),
});

export const customerDoc = v.object({
  _id: v.id("customers"),
  _creationTime: v.number(),
  name: v.string(),
  nameLower: v.string(),
  phone: v.string(),
  address: v.optional(v.string()),
  notes: v.optional(v.string()),
  active: v.boolean(),
  isWalkIn: v.optional(v.boolean()),
});

export const saleDoc = v.object({
  _id: v.id("sales"),
  _creationTime: v.number(),
  code: v.string(),
  customerId: v.id("customers"),
  salesChannelId: v.id("salesChannels"),
  deliveryCompanyId: v.optional(v.id("deliveryCompanies")),
  status: saleStatus,
  deliveryFee: v.number(),
  deliveryCost: v.number(),
  discount: v.number(),
  userId: v.id("users"),
  createdAt: v.number(),
  deliveredAt: v.optional(v.number()),
  note: v.optional(v.string()),
  // T17 — evening delivery reconciliation (see schema.ts sales table).
  deliveryOutcome: v.optional(
    v.union(
      v.literal("delivered"),
      v.literal("partial"),
      v.literal("returned"),
      v.literal("cancelled")
    )
  ),
  outcomeMarkedAt: v.optional(v.number()),
  imageStorageId: v.optional(v.id("_storage")),
  // Cancelled with the trip still billed (see schema.ts sales table). Must
  // stay in sync with the schema — a field missing here fails the returns
  // validator and rolls the whole mutation back.
  chargeDeliveryOnCancel: v.optional(v.boolean()),
  editedVersion: v.optional(v.number()),
});

export const saleItemDoc = v.object({
  _id: v.id("saleItems"),
  _creationTime: v.number(),
  saleId: v.id("sales"),
  variantId: v.id("productVariants"),
  unitPrice: v.number(),
  unitCostSnapshot: v.number(),
  qtyOrdered: v.number(),
  qtyDelivered: v.number(),
  qtyCancelled: v.number(),
  qtyReturned: v.number(),
  discount: v.optional(v.number()),
  // Internal add-on rows written by saveEdit raises (see schema). The edit
  // page never sees them — getEditData folds them into their parent.
  splitFromItemId: v.optional(v.id("saleItems")),
});

export const paymentDoc = v.object({
  _id: v.id("payments"),
  _creationTime: v.number(),
  saleId: v.id("sales"),
  amount: v.number(),
  receivedAt: v.number(),
  receivedDay: v.string(),
  method: paymentMethod,
  userId: v.id("users"),
  note: v.optional(v.string()),
});

export const expenseCategoryDoc = v.object({
  _id: v.id("expenseCategories"),
  _creationTime: v.number(),
  name: v.string(),
  nameLower: v.string(),
  active: v.boolean(),
});

export const expenseDoc = v.object({
  _id: v.id("expenses"),
  _creationTime: v.number(),
  amount: v.number(),
  category: v.string(),
  categoryLower: v.string(),
  spentAt: v.number(),
  spentDay: v.string(),
  note: v.optional(v.string()),
  userId: v.id("users"),
});

// T19 — one P/L report row (daily, or the aggregate of a month / year).
// All money lines are integer cents; toDay is exclusive.
export const plReport = v.object({
  periodType: v.union(v.literal("day"), v.literal("month"), v.literal("year")),
  periodValue: v.string(),
  fromDay: v.string(),
  toDay: v.string(),
  moneyIn: v.number(),
  refunds: v.number(),
  cogs: v.number(),
  deliveryIncome: v.number(),
  deliveryCost: v.number(),
  expenses: v.number(),
  profit: v.number(),
  paymentsCount: v.number(),
  expensesByCategory: v.array(v.object({ category: v.string(), amount: v.number() })),
});

export const saleEventDoc = v.object({
  _id: v.id("saleEvents"),
  _creationTime: v.number(),
  saleId: v.id("sales"),
  type: v.string(),
  summary: v.string(),
  payload: v.optional(v.record(v.string(), v.string())),
  userId: v.id("users"),
  ts: v.number(),
});

// --- POS / sales DTOs ---

/** A variant with computed stock and its effective sell price (override or product default). */
export const posVariantInfo = v.object({
  variant: productVariantDoc,
  stock: v.number(),
  price: v.number(),
});

/** A product for the POS picker: the product + its active variants. */
export const posProduct = v.object({
  product: productDoc,
  variants: v.array(posVariantInfo),
});

/** One addable variant for the sale-edit item picker — everything a new line
 * needs, plus the plain-language label the list shows. Searchable by product
 * name or SKU, so the picker finds a piece either way. */
export const addableVariant = v.object({
  variantId: v.id("productVariants"),
  productId: v.id("products"),
  productName: v.string(),
  label: v.string(), // "M · Black", or just "M" when the product has no colors
  sku: v.optional(v.string()),
  stock: v.number(),
  price: v.number(), // effective sell price: variant override or product default
  imageStorageId: v.optional(v.id("_storage")), // product photo, when the product has one
});

/** A sale line joined with the variant and product it sold. */
export const saleItemDetail = v.object({
  item: saleItemDoc,
  variant: productVariantDoc,
  product: productDoc,
  // What the customer currently holds — ALWAYS the derived difference
  // qtyDelivered − qtyReturned. qtyDelivered is historical and never
  // decremented (invariants 1, 5, 6).
  withCustomer: v.number(),
});

/** Full order detail with computed money (all integer cents). */
export const saleDetail = v.object({
  sale: saleDoc,
  customer: customerDoc,
  channel: salesChannelDoc,
  company: v.optional(deliveryCompanyDoc),
  items: v.array(saleItemDetail),
  payments: v.array(paymentDoc),
  // Audit trail (rule #8), newest first, joined with the actor's name.
  events: v.array(
    v.object({ event: saleEventDoc, userName: v.string() })
  ),
  total: v.number(),
  paid: v.number(),
  remaining: v.number(),
  profit: v.number(),
  createdByName: v.string(),
});

// --- Full-page sale edit (T12) ---

/** One desired line on the edit page. Existing lines are addressed by
 * `saleItemId`; a line with none is NEW and must carry `variantId`.
 * `qty` is the desired BILLED quantity (ordered − cancelled − returned) —
 * 0 means "remove this line". Lines the client doesn't send are left alone,
 * so a dropped row can never silently cancel stock.
 *
 * An EXISTING line may also carry a different `variantId` to swap the line
 * to another item (only while nothing on that line was delivered yet).
 *
 * `fulfillment` exists ONLY for new lines on a DELIVERED order: how the
 * customer gets these extra items. Handed now = fully delivered at this
 * moment (the order stays Delivered); deliver later = a second trip, so the
 * line starts delivered-0 and the order becomes Partially delivered. It is
 * rejected anywhere else. */
export const newItemFulfillment = v.union(
  v.literal("handed_now"),
  v.literal("deliver_later")
);

export const saleEditItemInput = v.object({
  saleItemId: v.optional(v.id("saleItems")),
  variantId: v.optional(v.id("productVariants")),
  qty: v.number(),
  discount: v.optional(v.union(v.number(), v.null())), // undefined = keep, null = clear
  price: v.optional(v.number()), // unit-price override; undefined = keep / re-derive
  fulfillment: v.optional(newItemFulfillment), // new lines on delivered orders only
});

// --- Return / correction resolutions (Edit Sale + guided cancel, T12+) ---

/** What physically happened to pieces the customer was holding. Sent by the
 * Edit Sale page / cancel review and applied by the SAME atomic mutation
 * (saveEdit / setStatus) — never a separate half-applied write. */
export const resolutionOutcome = v.union(
  v.literal("returned_sellable"), // goods came back, back on the shelf
  v.literal("returned_damaged"), // goods came back, cannot be sold
  v.literal("still_with_customer"), // nothing happened — line stays billed
  v.literal("delivery_incorrect") // never handed over; owner-only correction
);

/** One resolution: how many pieces of a line took a given outcome.
 * `reason` is required by the server for `delivery_incorrect` (audit trail);
 * the frontend shows the input only in that case. */
export const resolutionInput = v.object({
  saleItemId: v.id("saleItems"),
  outcome: resolutionOutcome,
  qty: v.number(),
  reason: v.optional(v.string()),
});

/** Optional refund paid at the same time (negative payments row, method
 * "refund"). Clamped server-side to what has actually been paid. */
export const refundInput = v.object({
  amount: v.number(),
  note: v.optional(v.string()),
});

/** One line on the edit page: the line + what it sells + the numbers the
 * quantity box needs. `stock` is what's on the shelf right now; the pieces
 * already on this order were deducted long ago, so the highest quantity this
 * line can be raised to is `maxQty` = billed + shelf.
 *
 * A raise never rewrites the line: the extra pieces become their OWN saleItems
 * row (saveEdit), priced at the variant's CURRENT sell price and costed at
 * the CURRENT weighted average — `currentPrice` is that price, so the edit
 * page's live totals price the raise exactly as the save will. */
export const saleEditLine = v.object({
  item: saleItemDoc,
  variant: productVariantDoc,
  product: productDoc,
  billedQty: v.number(),
  stock: v.number(),
  maxQty: v.number(),
  currentPrice: v.number(),
  // What happened to the pieces that came back — derived from the ledger,
  // so the items table can say "Returned · Sellable" / "Returned · Damaged"
  // instead of a generic "Removed". null = this line has no return history.
  returnedOutcome: v.union(v.literal("sellable"), v.literal("damaged"), v.null()),
});

/** Everything the edit page loads in one read. `version` is the order's edit
 * counter — the page sends it back on save and sales.saveEdit rejects a
 * mismatch (somebody else saved in between). */
export const saleEditData = v.object({
  sale: saleDoc,
  customer: customerDoc,
  channel: salesChannelDoc,
  company: v.optional(deliveryCompanyDoc),
  items: v.array(saleEditLine),
  total: v.number(),
  paid: v.number(),
  remaining: v.number(),
  version: v.number(),
});

/** One sales-list row: the sale + joined names + computed money (cents). */
export const saleListRow = v.object({
  sale: saleDoc,
  customerName: v.string(),
  customerPhone: v.string(),
  channelName: v.string(),
  total: v.number(),
  paid: v.number(),
  remaining: v.number(),
});

// --- Dashboard (T20) ---

/** One variant whose computed stock is at or below the shop's low-stock
 * threshold. `label` is the plain-language "Product — M · Black" string. */
export const lowStockItem = v.object({
  productId: v.id("products"),
  productName: v.string(),
  variantId: v.id("productVariants"),
  label: v.string(),
  qty: v.number(),
});

/** The dashboard's range filter: today, rolling 7/30 days, month to date,
 * year to date. Day boundaries are computed server-side in the shop tz. */
export const dashboardRange = v.union(
  v.literal("today"),
  v.literal("7d"),
  v.literal("30d"),
  v.literal("mtd"),
  v.literal("ytd")
);

/** The five KPI cards. All money is integer cents; `sales`/`purchases`/
 * `profit` cover the KPI window, `salesDue` and `invoices` the shop-wide
 * owing orders / invoices-in-range counts as defined in getOverview. */
export const dashboardKpis = v.object({
  sales: v.number(), // Σ payments in range (refunds net out)
  purchases: v.number(), // Σ qty × unitCost of purchases received in range
  salesDue: v.number(), // Σ remaining across all owing (non-cancelled) orders
  invoices: v.number(), // orders created in range
  profit: v.number(), // computePl profit over the range
});

/** One chart bucket: a day (YYYY-MM-DD) or month (YYYY-MM) with the money
 * received from payments and the cost of purchases received in that bucket. */
export const dashboardChartBucket = v.object({
  key: v.string(),
  sales: v.number(),
  purchases: v.number(),
});

/** Everything the dashboard shows, in one query (T20). All lists are small,
 * bounded reads (top 5s, low-stock 20, 5 recent sales) — no pagination. */
export const dashboardOverview = v.object({
  range: dashboardRange,
  fromDay: v.string(), // KPI window start, YYYY-MM-DD in shop tz
  toDay: v.string(), // KPI window end (exclusive)
  kpis: dashboardKpis,
  chart: v.object({
    type: v.union(v.literal("day"), v.literal("month")), // ytd → month, else day
    buckets: v.array(dashboardChartBucket), // zero-filled, ascending
  }),
  topProducts: v.array(
    v.object({
      variantId: v.id("productVariants"),
      label: v.string(), // "Product — M · Black"
      qty: v.number(), // billed pieces (ordered − cancelled − returned)
      revenue: v.number(), // Σ unitPrice × billed − item discounts, cents
    })
  ), // top 5 by qty desc
  otherQty: v.number(), // billed pieces of everything below the top 5
  topCustomers: v.array(
    v.object({
      customerId: v.id("customers"),
      name: v.string(),
      revenue: v.number(), // Σ payment amounts in range, cents (refunds net out)
    })
  ), // top 5 by revenue desc
  stockValue: v.object({
    totalValue: v.number(), // Σ max(qty, 0) × weighted-average cost, cents
    totalUnits: v.number(), // Σ max(qty, 0)
  }),
  lowStock: v.array(lowStockItem), // sorted by qty asc, max 20
  recentSales: v.array(saleListRow), // newest orders in range, max 5
});

// --- T24 CSV exports ---

/** One stock CSV row: an active variant with its current computed stock and
 * effective sell price (variant override or the product default). */
export const stockCsvRow = v.object({
  productName: v.string(),
  size: v.string(),
  color: v.optional(v.string()),
  sku: v.optional(v.string()),
  qty: v.number(),
  price: v.number(), // integer cents
});

/** One count-stock row: a product with all its variants and computed stock,
 * optionally filtered by category. Used for the stock count XLSX export. */
export const countStockRow = v.object({
  productName: v.string(),
  categoryName: v.string(),
  variants: v.array(
    v.object({
      size: v.string(),
      color: v.optional(v.string()),
      sku: v.optional(v.string()),
      qty: v.number(),
    })
  ),
  totalQty: v.number(),
});

/** One report CSV row: one day's cash-basis P/L line (same math as the
 * on-screen report — money counts on the day it is received). */
export const reportCsvRow = v.object({
  day: v.string(), // YYYY-MM-DD in shop tz
  moneyIn: v.number(),
  refunds: v.number(),
  cogs: v.number(),
  expenses: v.number(),
  profit: v.number(),
});

// --- T21 reports ---

/** One sales page (channel) row for a period: order count, revenue and
 * profit from the period's payments (cash basis — money counts when it is
 * received, attributed to the channel of its order). */
export const channelReportRow = v.object({
  channelId: v.id("salesChannels"),
  channelName: v.string(),
  orders: v.number(),
  revenue: v.number(),
  profit: v.number(),
});

/** One stock movement row joined with the product/variant label and the
 * actor's name ("Stock in / Stock out" — the full movement report). */
export const stockMovementRow = v.object({
  row: stockLedgerDoc,
  label: v.string(), // "Basic Tee — M · Black"
  userName: v.string(),
});

export const customerDebtAging = v.object({
  days0To7: v.number(),
  days8To30: v.number(),
  days31To60: v.number(),
  over60Days: v.number(),
});

export const customerDebtRow = v.object({
  customerId: v.id("customers"),
  customerName: v.string(),
  customerPhone: v.string(),
  totalOwed: v.number(),
  unpaidOrderCount: v.number(),
  aging: customerDebtAging,
  oldestOrderId: v.id("sales"),
  oldestOrderCode: v.string(),
  oldestOrderAt: v.number(),
  oldestAgeDays: v.number(),
});

export const customerDebtReport = v.object({
  asOfDay: v.string(),
  totalOwed: v.number(),
  customerCount: v.number(),
  aging: customerDebtAging,
  page: v.array(customerDebtRow),
  continueCursor: v.string(),
  total: v.number(),
});

export const productPerformanceTotals = v.object({
  unitsSold: v.number(),
  returnedUnits: v.number(),
  exchangedUnits: v.number(),
  revenue: v.number(),
  landedCost: v.number(),
  profit: v.number(),
});

export const productPerformanceRow = v.object({
  productId: v.id("products"),
  variantId: v.id("productVariants"),
  productName: v.string(),
  productCode: v.optional(v.string()),
  size: v.string(),
  color: v.optional(v.string()),
  sku: v.optional(v.string()),
  unitsSold: v.number(),
  returnedUnits: v.number(),
  exchangedUnits: v.number(),
  revenue: v.number(),
  landedCost: v.number(),
  profit: v.number(),
});

export const productPerformanceReport = v.object({
  periodType: v.union(v.literal("day"), v.literal("month"), v.literal("year")),
  periodValue: v.string(),
  fromDay: v.string(),
  toDay: v.string(),
  totals: productPerformanceTotals,
  page: v.array(productPerformanceRow),
  continueCursor: v.string(),
  total: v.number(),
});

export const inventoryValueRow = v.object({
  productId: v.id("products"),
  variantId: v.id("productVariants"),
  productName: v.string(),
  productCode: v.optional(v.string()),
  size: v.string(),
  color: v.optional(v.string()),
  sku: v.optional(v.string()),
  productActive: v.boolean(),
  variantActive: v.boolean(),
  active: v.boolean(),
  currentQty: v.number(),
  weightedLandedUnitCost: v.number(),
  totalValue: v.number(),
});

export const inventoryValueReport = v.object({
  totals: v.object({
    totalUnits: v.number(),
    totalValue: v.number(),
    variantCount: v.number(),
    inactiveVariantCount: v.number(),
  }),
  page: v.array(inventoryValueRow),
  continueCursor: v.string(),
  total: v.number(),
});

export const deadStockThreshold = v.union(
  v.literal(30),
  v.literal(60),
  v.literal(90),
  v.literal(180)
);

export const deadStockRow = v.object({
  productId: v.id("products"),
  variantId: v.id("productVariants"),
  productName: v.string(),
  productCode: v.optional(v.string()),
  size: v.string(),
  color: v.optional(v.string()),
  sku: v.optional(v.string()),
  active: v.boolean(),
  currentQty: v.number(),
  lastSoldAt: v.optional(v.number()),
  agingAnchorAt: v.number(),
  ageDays: v.number(),
  weightedLandedUnitCost: v.number(),
  tiedUpValue: v.number(),
});

export const deadStockReport = v.object({
  asOfDay: v.string(),
  thresholdDays: deadStockThreshold,
  totals: v.object({
    totalUnits: v.number(),
    tiedUpValue: v.number(),
    variantCount: v.number(),
    neverSoldCount: v.number(),
    inactiveVariantCount: v.number(),
  }),
  page: v.array(deadStockRow),
  continueCursor: v.string(),
  total: v.number(),
});

export const reorderDays = v.union(v.literal(30), v.literal(60), v.literal(90));

export const reorderPlanningRow = v.object({
  productId: v.id("products"),
  variantId: v.id("productVariants"),
  productName: v.string(),
  productCode: v.optional(v.string()),
  size: v.string(),
  color: v.optional(v.string()),
  sku: v.optional(v.string()),
  currentQty: v.number(),
  unitsSoldInLookback: v.number(),
  averageDailyUnits: v.number(),
  estimatedDaysRemaining: v.number(),
  suggestedReorderQty: v.number(),
  weightedLandedUnitCost: v.number(),
  estimatedReorderCost: v.number(),
});

export const reorderPlanningReport = v.object({
  asOfDay: v.string(),
  lookbackDays: reorderDays,
  targetDays: reorderDays,
  fromDay: v.string(),
  totals: v.object({
    variantCount: v.number(),
    suggestedUnits: v.number(),
    estimatedReorderCost: v.number(),
  }),
  page: v.array(reorderPlanningRow),
  continueCursor: v.string(),
  total: v.number(),
});

/** One ledger row belonging to a purchase — its stock trace (T21). */
export const purchaseTraceItem = v.object({
  row: stockLedgerDoc,
  userName: v.string(),
});

// --- T22 stock adjustments & stocktake ---

/** One countable variant for the stocktake / quick-adjustment picker:
 * plain-language label ("Basic Tee — M · Black") + computed stock. */
export const stocktakeVariant = v.object({
  variantId: v.id("productVariants"),
  productId: v.id("products"),
  label: v.string(),
  qty: v.number(),
  imageStorageId: v.optional(v.id("_storage")),
});

/** One recent adjustment/stocktake history row, newest first. */
export const adjustmentHistoryItem = v.object({
  row: stockLedgerDoc,
  label: v.string(),
  userName: v.string(),
});

/** What a stocktake save corrected: how many variants moved. */
export const stocktakeResult = v.object({
  written: v.number(),
  rows: v.array(
    v.object({
      variantId: v.id("productVariants"),
      before: v.number(),
      after: v.number(),
    })
  ),
});

/** Checkout payment method — "refund" is never a checkout choice. */
export const checkoutPaymentMethod = v.union(
  v.literal("cash"),
  v.literal("bank_transfer"),
  v.literal("other")
);

/** One checkout line: ids + qty + discount only — prices/costs are re-derived server-side. */
export const checkoutLine = v.object({
  variantId: v.id("productVariants"),
  qty: v.number(),
  discount: v.optional(v.number()),
});

/** Checkout payment: the amount the cashier RECEIVED. The server clamps the
 *  recorded row to the order total (change is given back, not kept), and
 *  `receivedAt` may backdate the payment (never into the future). */
export const checkoutPayment = v.object({
  method: checkoutPaymentMethod,
  amount: v.number(),
  note: v.optional(v.string()),
  receivedAt: v.optional(v.number()),
});

// --- Delivery reconciliation (T17) ---

export const deliveryOutcome = v.union(
  v.literal("delivered"),
  v.literal("partial"),
  v.literal("returned"),
  v.literal("cancelled")
);

/** One order on the evening screen: everything the owner needs to mark the
 * outcome — customer, what's in the package, the fee, and the money state. */
export const deliveryOrderRow = v.object({
  sale: saleDoc,
  customerName: v.string(),
  customerPhone: v.string(),
  customerAddress: v.optional(v.string()),
  itemSummary: v.string(), // e.g. "Basic Tee — M · Black ×2"
  total: v.number(),
  paid: v.number(),
  remaining: v.number(),
});

/** One company's section: open packages + today's marked outcomes + the
 * summary (handled, delivered, returns, cancellations, fee payable). */
export const deliveryGroup = v.object({
  company: v.optional(deliveryCompanyDoc), // absent = self-delivery / no company
  open: v.array(deliveryOrderRow),
  marked: v.array(deliveryOrderRow),
  handledCount: v.number(),
  deliveredCount: v.number(),
  partialCount: v.number(),
  returnsCount: v.number(),
  cancellationsCount: v.number(),
  feeTotal: v.number(), // Σ deliveryCost of open + marked, integer cents
});

export const deliveryReport = v.object({
  deliveryEnabled: v.boolean(),
  groups: v.array(deliveryGroup),
});
