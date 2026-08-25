"use client";

import {
  Delete02Icon,
  Home01Icon,
  Refresh01Icon,
  ShoppingCart01Icon,
  Tick02Icon,
  ShoppingBag
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import {
  InvoiceDialog,
  toPrintSale,
  type SaleDetail,
} from "@/components/features/sales/invoice-dialog";
import { PosCart } from "@/components/features/sales/pos-cart";
import { PosCustomerStep } from "@/components/features/sales/pos-customer-step";
import { PosFilterBar } from "@/components/features/sales/pos-filter-bar";
import {
  PosPaymentDialog,
  type CheckoutMethod,
  type PaymentCheckoutPayload,
} from "@/components/features/sales/pos-payment-dialog";
import { PosVariantGrid } from "@/components/features/sales/pos-variant-grid";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useCheckoutCart } from "@/hooks/use-checkout-cart";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useIdempotentSubmit } from "@/hooks/use-idempotent-submit";
import { useMediaQuery } from "@/hooks/use-media-query";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { printReceiptDoc, toastPrintError } from "@/lib/printing";
import {
  centsToInput,
  formatMoney,
  getLang,
  inputToCents,
  t,
  toastError,
} from "@/lib/utils";

// T10 / POS v4 — POS sale screen (AGENTS.md + the owner's layout spec).
// HEADER: page title + customer picker, then the product filters
// (category + size/variant + search). BODY: a 50/50 split — the LEFT half
// is the product card grid (up to 4 per row), the RIGHT half shows ONLY the
// cart lines (it scrolls its own items — never the whole page) plus ONE
// grid of order-level amounts (order discount + shipping fee side by side). FOOTER: desktop = Home / Reset / Refresh products
// + Subtotal on the left, Total Payable + Pay Now on the right; phone = a
// 3-item navigation bar (Home, Cart, Reset) where Cart swaps the body to
// the cart section (same lines + order discount + Pay Now) on the same
// page. Pay Now opens ONE popup
// (2xl Dialog on desktop, bottom Sheet on phone) titled "Payment Checkout"
// with three columns: transaction summary, payment method + paid amount +
// sale channel + delivery company grid + sale/payment dates, customer info +
// notes — its footer has ONLY Cancel + Complete payment.
//
// Checkout flow, in order: ① add items (qty, optional per-item discount)
// ② pick customer — the SELECTOR SITS IN THE HEADER and the Walk-in
// Customer (or the shop's configured default) is preselected ③ pick
// channel/page (required, inside the popup) ④ delivery company from a grid
// (the company's default fee is applied server-side) ⑤ one order-discount
// input (right column) ⑥ payment: leave the amount empty = unpaid, or
// enter what was received (method + payment date + notes in the popup)
// ⑦ Complete payment → print invoice.
// The client sends ids + quantities + intents only; every price, cost,
// total and stock check is re-derived server-side by api.sales.checkout.

export default function NewSalePage() {
  const user = useCurrentUser();
  const shop = useQuery(api.shop.get, user == null ? "skip" : {});
  const channels =
    useQuery(api.channels.listActive, user == null ? "skip" : {}) ?? [];
  const companies =
    useQuery(
      api.deliveryCompanies.listActive,
      user == null || shop == null || !shop.deliveryEnabled ? "skip" : {}
    ) ?? [];

  const currency = shop?.currency ?? "USD";
  const timezone = shop?.timezone ?? "Asia/Phnom_Penh";
  const deliveryEnabled = shop?.deliveryEnabled ?? false;
  const router = useRouter();

  // The cart is UI state — it survives reloads like every other preference.
  const { cart, addVariant, updateLine, removeLine, clear } = useCheckoutCart();

  // Product filters live in the HEADER and are owned here (persisted), so
  // the footer's Reset button can clear them.
  const [search, setSearch] = usePersistentState("pos:productSearch", "");
  const [sizeFilter, setSizeFilter] = usePersistentState("pos:sizeFilter", "");
  const [categoryFilter, setCategoryFilter] = usePersistentState(
    "pos:categoryFilter",
    ""
  );

  // The customer is stored as an id and derived from api.customers.get, so
  // edits (e.g. the add-address dialog) refresh the doc automatically.
  const [customerId, setCustomerId] = useState<Id<"customers"> | null>(null);
  const customer = useQuery(
    api.customers.get,
    customerId == null ? "skip" : { customerId }
  );

  // ② default customer: the shop's configured default, else the seeded
  // Walk-in Customer. The walk-in query can resolve BEFORE the default
  // (shop → customer is two hops), so an auto-pick is tracked in a ref and
  // upgraded once the configured default lands. A manual pick is never
  // clobbered — only null or the previous auto-pick gets replaced.
  const walkIn = useQuery(api.customers.getWalkIn, user == null ? "skip" : {});
  const defaultCustomer = useQuery(
    api.customers.get,
    user == null || shop?.defaultCustomerId == null
      ? "skip"
      : { customerId: shop.defaultCustomerId }
  );
  const autoSelectedRef = useRef<Id<"customers"> | null>(null);
  useEffect(() => {
    if (user == null) return;
    const target =
      defaultCustomer && defaultCustomer.active
        ? defaultCustomer
        : (walkIn ?? null);
    if (!target) return;
    if (customerId === null || customerId === autoSelectedRef.current) {
      autoSelectedRef.current = target._id;
      setCustomerId(target._id);
    }
  }, [user, customerId, defaultCustomer, walkIn]);

  const [channelId, setChannelId] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  // ⑤ Order-level amounts, side by side in one grid: the order discount and
  // the shipping fee charged TO THE CUSTOMER. Picking a delivery company
  // prefills the shipping fee with that company's default (④ fee auto-fill);
  // typing over it wins. What the shop PAYS the company is never entered
  // here — the server takes it from the company.
  const [discount, setDiscount] = useState("");
  const [shippingFee, setShippingFee] = useState("");
  // Last value the company auto-fill wrote — lets us tell "still the
  // suggested fee" (safe to replace) from "the cashier typed this".
  const autoFeeRef = useRef("");
  const [method, setMethod] = useState<CheckoutMethod>("cash");
  const [amount, setAmount] = useState("");

  // Order popup + grid control signals (Reset / Refresh buttons).
  const [orderOpen, setOrderOpen] = useState(false);
  const [resetTick, setResetTick] = useState(0);
  const [refreshTick, setRefreshTick] = useState(0);
  // Phone only: which body section shows — the product grid or the cart.
  // The footer's Cart nav item toggles it (no page redirect); desktop
  // always shows both columns and ignores this.
  const [showCart, setShowCart] = useState(false);
  const isDesktop = useMediaQuery("(min-width: 768px)");

  const [completing, setCompleting] = useState(false);
  // Ref guard: a double-click on Confirm must never submit twice — the
  // disabled prop alone can't stop two clicks in the same frame.
  const completingRef = useRef(false);
  const [invoice, setInvoice] = useState<SaleDetail | null>(null);

  const checkout = useMutation(api.sales.checkout);
  const checkoutSubmit = useIdempotentSubmit({
    operation: "sales.checkout",
    resource: "new",
  });

  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // iOS Safari pins position:fixed elements to the LAYOUT viewport, but SPA
  // navigation (Dashboard → Sale/New) and the payment Sheet's scroll lock can
  // leave the URL bar expanded — the visible area is then shorter than the
  // layout viewport and the portaled footer sits behind Safari's bottom bar
  // until a reload. Scrolling to the top collapses the bar, realigning both
  // viewports: on mount, and after the payment dialog closes.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  const prevOrderOpenRef = useRef(orderOpen);
  useEffect(() => {
    if (prevOrderOpenRef.current && !orderOpen) window.scrollTo(0, 0);
    prevOrderOpenRef.current = orderOpen;
  }, [orderOpen]);

  // ④ Delivery company → shipping-fee auto-fill. The company's default fee
  // lands in the shipping input; a fee the cashier typed themselves is never
  // clobbered (only an empty box or the previous suggestion is replaced).
  function onCompanyChange(value: string | null) {
    setCompanyId(value);
    const suggested =
      value === null
        ? ""
        : centsToInput(companies.find((c) => c._id === value)?.defaultFee ?? 0);
    const previous = autoFeeRef.current;
    autoFeeRef.current = suggested;
    setShippingFee((current) =>
      current === "" || current === previous ? suggested : current
    );
  }

  // Display totals only — the server re-derives everything at checkout.
  const subtotal = cart.reduce(
    (sum, line) =>
      sum + line.price * line.qty - (inputToCents(line.discount) ?? 0),
    0
  );
  // Total pieces in the cart — badge on the phone's Cart nav item.
  const cartQty = cart.reduce((sum, line) => sum + line.qty, 0);
  const discountCents = inputToCents(discount) ?? 0;
  // Shipping charged to the customer — what the grid input holds (prefilled
  // from the picked company, overridable). Delivery off = no shipping line.
  // The server re-validates the amount at checkout.
  const shippingCents = deliveryEnabled ? (inputToCents(shippingFee) ?? 0) : 0;
  const total = subtotal - discountCents + shippingCents;
  const amountCents = inputToCents(amount) ?? 0;
  // Empty amount = unpaid sale. Overpayment is allowed: the change goes back
  // to the customer and the server records only the net kept (clamped to the
  // total).
  const keptCents = Math.min(amountCents, total);
  const remaining = Math.max(0, total - keptCents);
  const changeDue = Math.max(0, amountCents - total);

  const canComplete =
    !completing &&
    cart.length > 0 &&
    customer != null &&
    channelId !== null &&
    (amount.trim() === "" || amountCents > 0);

  // Reset = clear ALL the things on the POS: cart, checkout selections and
  // the product filters. The customer falls back to the walk-in / default
  // preselection automatically.
  function resetPos() {
    clear();
    setShowCart(false);
    setCustomerId(null);
    setChannelId(null);
    setCompanyId(null);
    setDiscount("");
    setShippingFee("");
    autoFeeRef.current = "";
    setMethod("cash");
    setAmount("");
    setSearch("");
    setSizeFilter("");
    setCategoryFilter("");
    setResetTick((n) => n + 1);
  }

  async function complete(payload: PaymentCheckoutPayload) {
    if (!customer || !channelId) return;
    if (completingRef.current) return;
    completingRef.current = true;
    setCompleting(true);
    try {
      const paid = amountCents > 0;
      const checkoutPayload = {
        customerId: customer._id,
        salesChannelId: channelId as Id<"salesChannels">,
        ...(deliveryEnabled && companyId
          ? { deliveryCompanyId: companyId as Id<"deliveryCompanies"> }
          : {}),
        // The shipping fee the cashier sees in the grid is sent explicitly so
        // the charged total matches it exactly. deliveryCost stays OMITTED —
        // what the shop pays the company comes from the company itself.
        ...(deliveryEnabled ? { deliveryFee: shippingCents } : {}),
        discount: discountCents,
        items: cart.map((line) => ({
          variantId: line.variantId as Id<"productVariants">,
          qty: line.qty,
          ...(inputToCents(line.discount)
            ? { discount: inputToCents(line.discount)! }
            : {}),
        })),
        ...(paid
          ? {
              payment: {
                method,
                amount: amountCents,
                ...(payload.paymentNote
                  ? { note: payload.paymentNote }
                  : {}),
                ...(payload.receivedAt !== undefined
                  ? { receivedAt: payload.receivedAt }
                  : {}),
              },
            }
          : {}),
        // Only sent when the cashier backdated the sale date in the popup —
        // a normal sale keeps the exact `now` server-side.
        ...(payload.createdAt !== undefined
          ? { createdAt: payload.createdAt }
          : {}),
        ...(payload.saleNote ? { note: payload.saleNote } : {}),
      };
      const idempotencyKey = checkoutSubmit.begin(checkoutPayload);
      const detail = await checkout({ ...checkoutPayload, idempotencyKey });
      checkoutSubmit.complete(checkoutPayload, idempotencyKey);
      toast.success(t().sales.saleCreated.replace("{code}", detail.sale.code));
      // Close the popup BEFORE opening the invoice — both portal at z-50 and
      // the invoice must not render under the order dialog.
      setOrderOpen(false);
      setInvoice(detail);

      // T25 — auto-print the 80mm receipt when the shop has a printer set up.
      // Fire-and-forget: a failure only toasts; the open invoice dialog still
      // offers receipt / label / A5 re-prints.
      if (shop?.printerConfig) {
        printReceiptDoc(
          toPrintSale(detail, {
            shopName: shop.name,
            shopAddress: shop.address,
            currency,
            timezone,
          }),
          shop.printerConfig
        )
          .then(() => toast.success(t().sales.receiptSent))
          .catch(toastPrintError);
      }
      // Reset the flow for the next sale. The customer selector falls back
      // to the walk-in / default preselection automatically.
      clear();
      setShowCart(false);
      setCustomerId(null);
      setChannelId(null);
      setCompanyId(null);
      setDiscount("");
      setShippingFee("");
      autoFeeRef.current = "";
      setMethod("cash");
      setAmount("");
    } catch (err) {
      toastError(err);
    } finally {
      completingRef.current = false;
      setCompleting(false);
    }
  }

  // ⑤ Order-level amounts as ONE grid: order discount + shipping fee side by
  // side (one column when the delivery module is off — nothing to ship).
  // Rendered twice (desktop right column, phone cart section), so the input
  // ids take a suffix to stay unique in the DOM.
  const amountsGrid = (idSuffix: string) => (
    <div
      className={`grid shrink-0 gap-2 rounded-md border p-2 ${
        deliveryEnabled ? "grid-cols-2" : "grid-cols-1"
      }`}
    >
      <div className="min-w-0">
        <Label htmlFor={`pos-order-discount-${idSuffix}`} className="text-xs">
          {t().sales.orderDiscount}
        </Label>
        <InputGroup>
          <InputGroupAddon>{currency}</InputGroupAddon>
          <InputGroupInput
            id={`pos-order-discount-${idSuffix}`}
            inputMode="decimal"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
            placeholder="0.00"
            aria-label={t().sales.orderDiscount}
          />
        </InputGroup>
        <p className="text-xs text-muted-foreground">
          {t().sales.orderDiscountHint}
        </p>
      </div>
      {deliveryEnabled && (
        <div className="min-w-0">
          <Label htmlFor={`pos-shipping-fee-${idSuffix}`} className="text-xs">
            {t().sales.deliveryFee}
          </Label>
          <InputGroup>
            <InputGroupAddon>{currency}</InputGroupAddon>
            <InputGroupInput
              id={`pos-shipping-fee-${idSuffix}`}
              inputMode="decimal"
              value={shippingFee}
              onChange={(e) => setShippingFee(e.target.value)}
              placeholder="0.00"
              aria-label={t().sales.deliveryFee}
            />
          </InputGroup>
          <p className="text-xs text-muted-foreground">
            {t().sales.deliveryFeeHint}
          </p>
        </div>
      )}
    </div>
  );

  // One copy of the payment popup — rendered by whichever container matches
  // the viewport (Dialog on desktop, bottom Sheet on phone).
  const paymentPanel = (
    <PosPaymentDialog
      open={orderOpen}
      currency={currency}
      customer={customer ?? null}
      cart={cart}
      total={total}
      channels={channels}
      channelId={channelId}
      onChannelIdChange={setChannelId}
      deliveryEnabled={deliveryEnabled}
      companies={companies}
      companyId={companyId}
      onCompanyChange={onCompanyChange}
      method={method}
      onMethodChange={setMethod}
      amount={amount}
      onAmountChange={setAmount}
      amountCents={amountCents}
      remaining={remaining}
      changeDue={changeDue}
      canComplete={canComplete}
      completing={completing}
      onCancel={() => setOrderOpen(false)}
      onConfirm={(payload) => void complete(payload)}
    />
  );

  const mobileFooter = (
    <footer className="fixed inset-x-0 bottom-0 z-[100] border-t bg-background px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 md:hidden">
      <div className="grid grid-cols-5 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          className="flex h-12 flex-1 flex-col items-center justify-center gap-0.5 px-0 text-[11px] font-normal text-muted-foreground"
          onClick={() => router.push("/dashboard")}
        >
          <HugeiconsIcon icon={Home01Icon} strokeWidth={2} className="size-5" />
          {t().sales.home}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="flex h-12 flex-1 flex-col items-center justify-center gap-0.5 px-0 text-[11px] font-normal text-muted-foreground"
          onClick={() => router.push("/sales")}
        >
          <HugeiconsIcon icon={ShoppingBag} strokeWidth={2} className="size-5" />
          {t().sales.reviewSale}
        </Button>
        <Button
          type="button"
          variant="ghost"
          aria-pressed={showCart}
          className={`flex h-12 flex-1 flex-col items-center justify-center gap-0.5 px-0 text-[11px] font-normal ${
            showCart ? "bg-primary/5 text-primary" : "text-muted-foreground"
          }`}
          onClick={() => setShowCart((value) => !value)}
        >
          <span className="relative">
            <HugeiconsIcon icon={ShoppingCart01Icon} strokeWidth={2} className="size-5" />
            {cartQty > 0 ? (
              <span className="absolute -right-2.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-0.5 text-[10px] font-bold leading-none text-primary-foreground tabular-nums">
                {cartQty > 99 ? "99+" : cartQty}
              </span>
            ) : null}
          </span>
          {t().sales.cart}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="flex h-12 flex-1 flex-col items-center justify-center gap-0.5 px-0 text-[11px] font-normal text-muted-foreground"
          onClick={resetPos}
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} className="size-5" />
          {t().sales.reset}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="flex h-12 flex-1 flex-col items-center justify-center gap-0.5 px-0 text-[11px] font-medium text-primary disabled:text-muted-foreground"
          disabled={cart.length === 0}
          onClick={() => setOrderOpen(true)}
        >
          <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-5" />
          {t().sales.payNow}
        </Button>
      </div>
    </footer>
  );

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-x-clip bg-background">
      {/* HEADER — ONE flex row (POS-specific, same visual tokens as the
          shared PageToolbar): page title + customer picker + product
          filters (category + size/variant + search). Wraps only when
          space runs out on narrow screens. */}
      <div
        className={cn(
          "min-h-14 max-h-[45dvh] shrink-0 flex-wrap items-center gap-x-3 gap-y-2 overflow-y-auto overscroll-contain border-b px-2 py-2 sm:px-4 md:flex",
          showCart ? "hidden" : "flex",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <HugeiconsIcon
            icon={ShoppingCart01Icon}
            strokeWidth={2}
            className="size-5 shrink-0 text-muted-foreground"
          />
          <h1 className="truncate font-heading text-lg font-semibold">
            {t().sales.newSale}
          </h1>
        </div>
        <div className="flex min-w-48 flex-1">
          <PosCustomerStep
            customerId={customerId}
            onSelect={(c) => setCustomerId(c._id)}
          />
        </div>
        <div
          className={cn(
            "min-w-0 flex-[2_1_20rem]",
            showCart && "hidden md:block",
          )}
        >
          <PosFilterBar
            search={search}
            onSearch={setSearch}
            sizeFilter={sizeFilter}
            onSizeFilter={setSizeFilter}
            categoryFilter={categoryFilter}
            onCategoryFilter={setCategoryFilter}
          />
        </div>
      </div>
      {/* BODY — two equal halves as flex. Both halves scroll independently;
          the RIGHT column scrolls only its items, never the whole page. */}
      <section className="min-h-0 flex-1 overflow-hidden p-2 sm:p-4">
        <div className="flex h-full min-h-0 items-stretch gap-2 sm:gap-4">
          {/* LEFT — the product card grid, up to 4 per row. On the phone it
              hides while the cart section is open. */}
          <div
            className={cn(
              "min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2",
              showCart ? "hidden md:block" : "",
            )}
          >
            <PosVariantGrid
              key={refreshTick}
              resetSignal={resetTick}
              currency={currency}
              onAdd={addVariant}
              cart={cart}
              search={search}
              size={sizeFilter}
              categoryId={categoryFilter}
            />
          </div>

          {/* RIGHT — only the products added to the cart (the items scroll
              on their own) + the ONE order-discount input. */}
          <aside className="hidden min-h-0 flex-1 flex-col gap-2 md:flex">
            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border p-2">
              <PosCart
                bare
                lines={cart}
                currency={currency}
                onUpdate={updateLine}
                onRemove={removeLine}
              />
            </div>
            {amountsGrid("desktop")}
          </aside>

          {/* PHONE cart section — the same lines (qty steppers + per-item
              discount) and order-discount input as the right column, plus
              Total Payable + Pay Now (the phone footer is navigation only).
              It swaps in for the product grid when the footer's Cart item
              is active — same page, no redirect. */}
          <div
            className={cn(
              showCart ? "flex" : "hidden",
              "h-full min-h-0 flex-1 flex-col overflow-hidden md:hidden",
            )}
          >
            {/* Only this area scrolls. */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div className="rounded-md border p-2">
                <PosCart
                  bare
                  lines={cart}
                  currency={currency}
                  onUpdate={updateLine}
                  onRemove={removeLine}
                />
              </div>
            </div>
            <div className="mt-2 shrink-0">{amountsGrid("mobile")}</div>
            <div className="mt-2 flex shrink-0 items-center gap-3 rounded-md border bg-background p-2">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">
                  {t().sales.totalPayable}
                </p>
                <p className="truncate text-lg font-bold tabular-nums">
                  {formatMoney(total, currency, getLang())}
                </p>
              </div>
              <Button
                type="button"
                className="h-11 min-w-0 flex-1"
                disabled={cart.length === 0}
                onClick={() => setOrderOpen(true)}
              >
                <HugeiconsIcon
                  icon={Tick02Icon}
                  strokeWidth={2}
                  className="size-4"
                  aria-hidden="true"
                />
                {t().sales.payNow}
              </Button>
            </div>
          </div>
        </div>
      </section>
      <div
        aria-hidden="true"
        className="h-[calc(4rem+env(safe-area-inset-bottom))] shrink-0 md:hidden"
      />
      {/* FOOTER — desktop: left Home / Reset / Refresh + Subtotal, right
          Total Payable + Pay Now. Phone keeps navigation and Pay Now always
          reachable; Cart toggles the cart section on the same page. */}
      <footer className="hidden shrink-0 border-t bg-background px-4 py-2 md:block">
        {/* Desktop bar — unchanged. */}
        <div className="hidden items-center gap-2 md:flex">
          <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
            <Link
              href="/dashboard"
              aria-label={t().sales.home}
              className={cn(
                buttonVariants({
                  variant: "outline",
                  size: "sm",
                  className: "size-11 shrink-0 px-0 sm:h-9 sm:w-auto sm:px-3",
                }),
              )}
            >
              <HugeiconsIcon
                icon={Home01Icon}
                strokeWidth={2}
                className="size-4"
                aria-hidden="true"
              />
              <span className="hidden sm:inline">{t().sales.home}</span>
            </Link>
            <Link
              href="/sales"
              aria-label={t().sales.reviewSale}
              className={cn(
                buttonVariants({
                  variant: "outline",
                  size: "sm",
                  className: "size-11 shrink-0 px-0 sm:h-9 sm:w-auto sm:px-3",
                }),
              )}
            >
              <HugeiconsIcon
                icon={ShoppingBag}
                strokeWidth={2}
                className="size-4"
                aria-hidden="true"
              />
              <span className="hidden sm:inline">{t().sales.reviewSale}</span>
            </Link>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="size-11 shrink-0 px-0 sm:h-9 sm:w-auto sm:px-3"
              onClick={resetPos}
              aria-label={t().sales.reset}
            >
              <HugeiconsIcon
                icon={Delete02Icon}
                strokeWidth={2}
                className="size-4"
                aria-hidden="true"
              />

              <span className="hidden sm:inline">{t().sales.reset}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="size-11 shrink-0 px-0 sm:h-9 sm:w-auto sm:px-3"
              onClick={() => setRefreshTick((n) => n + 1)}
              aria-label={t().sales.refreshProducts}
            >
              <HugeiconsIcon
                icon={Refresh01Icon}
                strokeWidth={2}
                className="size-4"
                aria-hidden="true"
              />

              <span className="hidden sm:inline">
                {t().sales.refreshProducts}
              </span>
            </Button>

            {/* Subtotal — footer of the LEFT column. */}
            <div className="ml-1 min-w-0">
              <p className="truncate text-xs text-muted-foreground">
                {t().sales.subtotal}
              </p>
              <p className="truncate text-sm font-bold tabular-nums">
                {formatMoney(subtotal, currency, getLang())}
              </p>
            </div>
          </div>

          <div className="ml-auto flex min-w-0 items-center gap-3">
            <div className="min-w-0">
              <p className="truncate text-xs text-muted-foreground">
                {t().sales.totalPayable}
              </p>
              <p className="truncate text-sm font-bold tabular-nums sm:text-lg">
                {formatMoney(total, currency, getLang())}
              </p>
            </div>
            <Button
              type="button"
              size="lg"
              className="h-11 shrink-0"
              disabled={cart.length === 0}
              onClick={() => setOrderOpen(true)}
            >
              <HugeiconsIcon
                icon={Tick02Icon}
                strokeWidth={2}
                className="size-4"
              />
              {t().sales.payNow}
            </Button>
          </div>
        </div>
      </footer>
      {mounted && !orderOpen ? createPortal(mobileFooter, document.body) : null}
      {/* Payment popup — one panel, two containers (2xl Dialog on desktop,
          bottom Sheet on phone; only the matching one ever opens). */}
      <Dialog
        open={orderOpen && isDesktop}
        onOpenChange={(o) => {
          if (!o && !completing) setOrderOpen(false);
        }}
      >
        <DialogContent className="flex h-[90dvh] max-h-[90dvh] max-w-[min(56rem,calc(100vw_-_2rem))] flex-col gap-4 overflow-hidden sm:max-w-[min(56rem,calc(100vw_-_2rem))]">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t().sales.paymentCheckout}</DialogTitle>
            <DialogDescription className="sr-only">
              {t().sales.paymentCheckout}
            </DialogDescription>
          </DialogHeader>
          {paymentPanel}
        </DialogContent>
      </Dialog>
      <Sheet
        open={orderOpen && !isDesktop}
        onOpenChange={(o) => {
          if (!o && !completing) setOrderOpen(false);
        }}
      >
        <SheetContent
          side="bottom"
          className="gap-0 overflow-hidden p-0"
          style={{ height: "95svh", maxHeight: "95svh" }}
        >
          <SheetHeader className="shrink-0 border-b px-4 py-3 text-left">
            <SheetTitle>{t().sales.paymentCheckout}</SheetTitle>
            <SheetDescription className="sr-only">
              {t().sales.paymentCheckout}
            </SheetDescription>
          </SheetHeader>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
            {paymentPanel}
          </div>
        </SheetContent>
      </Sheet>
      <InvoiceDialog
        detail={invoice}
        shopName={shop?.name ?? ""}
        shopAddress={shop?.address}
        currency={currency}
        timezone={timezone}
        printerConfig={shop?.printerConfig}
        onClose={() => setInvoice(null)}
      />
    </div>
  );
}
