"use client";

import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Image01Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import type { CartLine } from "@/hooks/use-checkout-cart";
import { formatMoney, getLang, imageUrl, t } from "@/lib/utils";

// POS v4 — the LEFT 50% column of the sale page (AGENTS.md: products on the
// left, cart on the right). ONE CARD PER VARIANT, four per row on desktop.
// Each card shows its own SKU, product code and live stock, with the
// effective price (variant override or product default). The whole card is a
// tap target — clicking anywhere adds qty 1; the small (+) circle bottom-right
// is a second, always-visible way to add.
//
// Filters (search / category / size) now live in the PAGE HEADER — the page
// owns the persisted values and passes them down; the debounced search copy
// drives the server query. Out-of-stock variants are hidden entirely. A
// page's variants load in ONE batch query (api.pos.getVariantsForProducts) —
// no per-card queries. Prices/stock here are display-only — the server
// re-derives every price and re-checks stock at checkout.

const PAGE_SIZE = 24;

/** One active variant with computed ledger stock + effective price. */
type PosVariant = { variant: Doc<"productVariants">; stock: number; price: number };

export function PosVariantGrid({
  currency,
  onAdd,
  cart,
  search,
  size,
  categoryId,
  resetSignal,
}: {
  currency: string;
  /** Add one variant to the cart (qty 1 — repeat taps bump the cart line). */
  onAdd: (line: Omit<CartLine, "key">) => void;
  /** The live cart — cards for variants already in it get a highlight. */
  cart: CartLine[];
  /** Persisted filter values — owned by the page's header filter bar. */
  search: string;
  size: string;
  categoryId: string;
  /** Bumped by the page footer's Reset button — jumps back to page 1. */
  resetSignal?: number;
}) {
  const user = useCurrentUser();

  // Which variants are already in the cart — their cards show a selected
  // highlight so the cashier sees at a glance what was already tapped.
  const inCartIds = useMemo(
    () => new Set(cart.map((line) => line.variantId)),
    [cart]
  );

  // The page updates `search` on every keystroke; only the debounced copy
  // drives the server query.
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Cursor pagination with a history stack: `pages` holds the cursor of every
  // visited page (page 1 = null), so Prev is a stack pop — works for both
  // Convex cursors and the size-path offset strings. Any filter/search change
  // resets back to page 1 (results changed, old cursors are meaningless).
  const [cursor, setCursor] = useState<string | null>(null);
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const resetPage = () => {
    setCursor(null);
    setPages([null]);
  };
  const goNext = () => {
    if (!products || products.continueCursor === "") return;
    const target = products.continueCursor;
    // Guard against a double-click before the re-render: never push the
    // same cursor twice.
    setPages((p) => (p[p.length - 1] === target ? p : [...p, target]));
    setCursor(target);
  };
  const goPrev = () => {
    if (pages.length <= 1) return;
    const next = pages.slice(0, -1);
    setPages(next);
    setCursor(next[next.length - 1]);
  };

  // Filter change → back to page 1 (skip the first render — only CHANGES
  // matter).
  const prevFilters = useRef({ search, size, categoryId });
  useEffect(() => {
    if (
      prevFilters.current.search === search &&
      prevFilters.current.size === size &&
      prevFilters.current.categoryId === categoryId
    ) {
      return;
    }
    prevFilters.current = { search, size, categoryId };
    resetPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, size, categoryId]);

  // Reset: back to page 1 (the filters themselves are cleared by the page).
  const prevReset = useRef(resetSignal);
  useEffect(() => {
    if (prevReset.current === resetSignal) return;
    prevReset.current = resetSignal;
    resetPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  const products = useQuery(
    api.pos.searchProducts,
    user == null
      ? "skip"
      : {
          paginationOpts: { numItems: PAGE_SIZE, cursor },
          search: debouncedSearch.trim() || undefined,
          size: size || undefined,
          // Persisted as a plain string; re-tag at the wire edge.
          categoryId: (categoryId || undefined) as Id<"categories"> | undefined,
        }
  );

  // Whole grid page's variants in ONE batch query. Page turns flip this to
  // undefined for a beat — cards render skeletons, never stale data.
  const pageProductIds = useMemo(
    () => (products?.page ?? []).map((p) => p._id),
    [products]
  );
  const variantsPage = useQuery(
    api.pos.getVariantsForProducts,
    user == null || products === undefined
      ? "skip"
      : { productIds: pageProductIds }
  );
  const variantsById = useMemo(
    () =>
      new Map((variantsPage ?? []).map((item) => [item.product._id, item.variants])),
    [variantsPage]
  );

  // Flatten each product into one card per active variant, hiding every
  // variant with no available stock. The size filter already narrowed the
  // product page server-side; the client filter keeps only the matching
  // SIZE's cards (the batch returns all of a product's variants regardless
  // of the filter).
  const cards = useMemo(() => {
    if (products === undefined || variantsPage === undefined) return undefined;
    return products.page.flatMap((product) => {
      const list = variantsById.get(product._id) ?? [];
      return list
        .filter((info) => info.stock > 0 && (!size || info.variant.size === size))
        .map((info) => ({ product, info }));
    });
  }, [products, variantsPage, variantsById, size]);

  const currentPage = pages.length;
  const totalPages = Math.max(1, Math.ceil((products?.total ?? 0) / PAGE_SIZE));

  return (
    <div className="flex flex-col gap-3">
      {cards === undefined && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[3/4] w-full rounded-md" />
          ))}
        </div>
      )}
      {cards !== undefined && cards.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {search !== "" || size !== "" || categoryId !== ""
            ? t().sales.noProducts
            : t().sales.noProductsInStock}
        </p>
      )}
      {cards !== undefined && cards.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {cards.map(({ product, info }) => (
            <VariantCard
              key={info.variant._id}
              product={product}
              info={info}
              currency={currency}
              inCart={inCartIds.has(info.variant._id)}
              onAdd={onAdd}
            />
          ))}
        </div>
      )}

      {/* Compact pagination: prev / "Page n of m" / next. */}
      {products !== undefined && totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 text-sm">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7"
            disabled={currentPage <= 1}
            onClick={goPrev}
            aria-label={t().common.back}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-4" />
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t().common.page} {currentPage} {t().common.of} {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-7"
            disabled={products.continueCursor === ""}
            onClick={goNext}
            aria-label={t().common.more}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** One compact variant card: small image, bold "Name – Size · Color",
 *  "SKU, CODE, Qty" meta line, price bottom-left, (+) bottom-right. The whole
 *  card adds qty 1; the (+) circle is a second visible tap target. */
function VariantCard({
  product,
  info,
  currency,
  inCart,
  onAdd,
}: {
  product: Doc<"products">;
  info: PosVariant;
  currency: string;
  /** True when this variant is already in the cart — highlighted card. */
  inCart: boolean;
  onAdd: (line: Omit<CartLine, "key">) => void;
}) {
  const { variant, stock, price } = info;
  const label = `${product.name} – ${variant.size}${variant.color ? ` · ${variant.color}` : ""}`;
  // Exact card format: "SKU001, CODE-A-L, Qty: 20" — parts that exist are
  // joined, qty always last.
  const meta = `${[variant.sku, product.code].filter(Boolean).join(", ")}${
    [variant.sku, product.code].some(Boolean) ? ", " : ""
  }${t().sales.qty}: ${stock}`;

  const add = () =>
    onAdd({
      variantId: variant._id,
      label,
      price,
      qty: 1,
      discount: "",
      stock,
      imageStorageId: product.imageStorageId,
    });

  return (
    <button
      type="button"
      onClick={add}
      aria-label={label}
      aria-pressed={inCart}
      className={`group relative flex flex-col overflow-hidden rounded-md border bg-card text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
        inCart ? "border-primary bg-primary/5" : ""
      }`}
    >
      {product.imageStorageId ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl(product.imageStorageId)}
          alt={product.name}
          className="aspect-[4/3] w-full border-b object-cover"
        />
      ) : (
        <span className="flex aspect-[4/3] w-full items-center justify-center border-b bg-muted text-muted-foreground">
          <HugeiconsIcon icon={Image01Icon} strokeWidth={2} className="size-5" />
        </span>
      )}
      <span className="flex flex-1 flex-col gap-0.5 p-1.5">
        <span className="line-clamp-2 text-xs font-semibold leading-tight">
          {label}
        </span>
        <span className="truncate text-[11px] tabular-nums text-muted-foreground">
          {meta}
        </span>
        <span className="mt-auto flex items-center justify-between gap-1 pt-0.5">
          <span className="text-sm font-bold tabular-nums">
            {formatMoney(price, currency, getLang())}
          </span>
          <span
            role="button"
            tabIndex={0}
            aria-label={t().sales.addToCart}
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-transform group-hover:scale-110"
            onClick={(e) => {
              e.stopPropagation();
              add();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
                add();
              }
            }}
          >
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-3.5" />
          </span>
        </span>
      </span>
    </button>
  );
}
