"use client";

import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  Image01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { use, useMemo, useState } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import {
  VariantHistorySheet,
  type VariantSheetTarget,
} from "@/components/features/stock/variant-history-sheet";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { formatDateTime, getLang, imageUrl, isConvexId, t } from "@/lib/utils";

// T6 — one product's stock (AGENTS.md), redesigned: breadcrumb (Stock /
// product), a compact summary header, client-side variant controls (search /
// status filter / qty sort, persisted) and one row per size × color combo
// with its computed stock (sum of ledger deltas). "View movements" opens the
// drawer/sheet — the flow is Stock list → View variants → View movements.
// The id in the URL is the Convex UUID — never an enumerable number.

type StatusFilter = "all" | "in" | "low" | "out";
type QtySort = "none" | "asc" | "desc";

function StatusBadge({ qty, threshold }: { qty: number; threshold: number }) {
  const labels = t().stock;
  if (qty === 0) {
    return <Badge variant="destructive">{labels.statusOutOfStock}</Badge>;
  }
  if (qty <= threshold) {
    return <Badge variant="warning">{labels.statusLowStock}</Badge>;
  }
  return <Badge variant="success">{labels.statusInStock}</Badge>;
}

export default function StockDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      <div className="flex flex-col gap-4 p-4">
        {/* key={id} remounts a fresh boundary when navigating between ids */}
        <QueryErrorBoundary
          key={id}
          fallbackTitle={t().stock.notFoundTitle}
          fallbackBody={t().stock.notFoundBody}
        >
          <StockLoader id={id} />
        </QueryErrorBoundary>
      </div>
    </div>
  );
}

// The query-driven part — it must live BELOW the boundary so a render-phase
// throw (a checksum-invalid id the client can't verify) is caught here.
function StockLoader({ id }: { id: string }) {
  const user = useCurrentUser();
  // Fast-path check for obviously malformed ids — avoids firing a doomed
  // request; the boundary above catches anything this misses.
  const validId = isConvexId(id);
  const item = useQuery(
    api.stock.getProduct,
    user == null || !validId ? "skip" : { productId: id as Id<"products"> },
  );
  const shop = useQuery(api.shop.get, user == null ? "skip" : {});

  // Variant controls persist in the browser like every other list filter.
  const [search, setSearch] = usePersistentState("stockDetail:search", "");
  const [status, setStatus] = usePersistentState<StatusFilter>(
    "stockDetail:status",
    "all",
  );
  const [sort, setSort] = usePersistentState<QtySort>("stockDetail:sort", "none");
  // Keep the selected target after close so reopening remembers the variant.
  // The history query itself pauses while closed to avoid hidden rerenders.
  const [sheetTarget, setSheetTarget] = useState<VariantSheetTarget | null>(
    null,
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  const threshold = shop?.lowStockThreshold ?? 5;
  const rows = useMemo(() => {
    if (item === undefined || item === null) return [];
    const q = search.trim().toLowerCase();
    let out = item.variants;
    if (q !== "") {
      out = out.filter(({ variant }) =>
        [variant.size, variant.color, variant.sku].some((value) =>
          value?.toLowerCase().includes(q),
        ),
      );
    }
    if (status !== "all") {
      out = out.filter(({ qty }) =>
        status === "out"
          ? qty === 0
          : status === "low"
            ? qty > 0 && qty <= threshold
            : qty > threshold,
      );
    }
    if (sort !== "none") {
      out = [...out].sort((a, b) =>
        sort === "asc" ? a.qty - b.qty : b.qty - a.qty,
      );
    }
    return out;
  }, [item, search, status, sort, threshold]);

  if (!validId || item === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().stock.notFoundTitle}</CardTitle>
          <CardDescription>{t().stock.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (item === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }

  const labels = t().stock;
  const lang = getLang();
  const timezone = shop?.timezone ?? "Asia/Phnom_Penh";
  const totalQty = item.variants.reduce((sum, v) => sum + v.qty, 0);
  const lowOrOut = item.variants.filter((v) => v.qty <= threshold).length;
  const hasFilters = search.trim() !== "" || status !== "all" || sort !== "none";

  return (
    <>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/stock" />}>
              {t().nav.stock}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{item.product.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {/* Product photo — same pattern as the stock list / products. */}
              {item.product.imageStorageId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={imageUrl(item.product.imageStorageId)}
                  alt={item.product.name}
                  className="size-14 shrink-0 rounded-md border object-cover"
                />
              ) : (
                <span className="flex size-14 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                  <HugeiconsIcon
                    icon={Image01Icon}
                    strokeWidth={2}
                    className="size-6"
                  />
                </span>
              )}
              <div className="min-w-0">
                <CardTitle className="truncate">{item.product.name}</CardTitle>
                {item.product.description ? (
                  <CardDescription>{item.product.description}</CardDescription>
                ) : null}
              </div>
            </div>
            {/* The ONE primary action of this view. A real anchor (not a
                Base UI Button render) keeps link semantics and no console
                warning — same pattern as the reorder-alert actions. */}
            <Link href="/adjustments" className={buttonVariants()}>
              <HugeiconsIcon
                icon={ClipboardCheckIcon}
                strokeWidth={2}
                className="size-4"
              />
              {labels.adjustStock}
            </Link>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <span className="flex items-baseline gap-2">
              <span className="text-muted-foreground">
                {labels.availableStock}
              </span>
              <span className="font-mono text-lg font-semibold tabular-nums">
                {totalQty}
              </span>
            </span>
            <span className="text-muted-foreground">
              {labels.variantsSummary.replace(
                "{n}",
                String(item.variants.length),
              )}
            </span>
            {lowOrOut > 0 && (
              <Badge variant="warning">
                {lowOrOut} {labels.statusLowStock}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {/* Controls: search / status filter / qty sort / clear. */}
          <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
            <InputGroup className="w-full sm:w-64">
              <InputGroupAddon>
                <HugeiconsIcon
                  icon={Search01Icon}
                  strokeWidth={2}
                  className="size-4"
                />
              </InputGroupAddon>
              <InputGroupInput
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={labels.variantSearchPlaceholder}
                aria-label={labels.variantSearchPlaceholder}
              />
            </InputGroup>
            <Select
              value={status}
              // Base UI shows the RAW value in the trigger without this map.
              items={{
                all: labels.allStatuses,
                in: labels.statusInStock,
                low: labels.statusLowStock,
                out: labels.statusOutOfStock,
              }}
              onValueChange={(value) => {
                // Values come only from the SelectItems below, so the cast is safe.
                if (value != null) setStatus(value as StatusFilter);
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{labels.allStatuses}</SelectItem>
                <SelectItem value="in">{labels.statusInStock}</SelectItem>
                <SelectItem value="low">{labels.statusLowStock}</SelectItem>
                <SelectItem value="out">{labels.statusOutOfStock}</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={sort !== "none"}
              onClick={() =>
                setSort(sort === "none" ? "asc" : sort === "asc" ? "desc" : "none")
              }
            >
              <HugeiconsIcon
                icon={
                  sort === "asc"
                    ? ArrowUp01Icon
                    : sort === "desc"
                      ? ArrowDown01Icon
                      : ArrowUpDownIcon
                }
                strokeWidth={2}
                className="size-4"
              />
              {labels.sortByQty}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!hasFilters}
              onClick={() => {
                setSearch("");
                setStatus("all");
                setSort("none");
              }}
            >
              {labels.clearFilters}
            </Button>
          </div>

          {/* Bordered table per the UI conventions; one row per size (× color).
              Fixed layout on phones keeps the visible columns inside the
              viewport; back to auto from sm up. */}
          <Table className="table-fixed sm:table-auto">
            <TableHeader>
              <TableRow>
                <TableHead>{labels.variantCol}</TableHead>
                {/* SKU + last movement hide on phones so the table never
                    scrolls sideways — Variant / Available / Status / Actions
                    are the essentials there (same pattern as the list's
                    "Last updated" hiding on tablets). */}
                <TableHead className="hidden sm:table-cell">{labels.skuCol}</TableHead>
                <TableHead className="w-16 text-right sm:w-auto">
                  {labels.availableStock}
                </TableHead>
                <TableHead className="w-28 sm:w-auto">{labels.statusCol}</TableHead>
                <TableHead className="hidden sm:table-cell">
                  {labels.lastMovementCol}
                </TableHead>
                <TableHead className="w-20 text-right sm:w-auto">
                  {t().common.actions}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-muted-foreground"
                  >
                    {item.variants.length === 0
                      ? t().common.noResults
                      : labels.filteredEmpty}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map(({ variant, qty, lastMovementTs }) => (
                  <TableRow key={variant._id}>
                    <TableCell>
                      <span className="font-medium">{variant.size}</span>{" "}
                      <span className="text-muted-foreground">
                        / {variant.color ?? labels.noColor}
                      </span>
                    </TableCell>
                    <TableCell className="hidden font-mono text-sm text-muted-foreground sm:table-cell">
                      {variant.sku ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {qty}
                    </TableCell>
                    <TableCell>
                      <StatusBadge qty={qty} threshold={threshold} />
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                      {lastMovementTs !== undefined
                        ? formatDateTime(lastMovementTs, timezone, lang)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {/* Icon-only on phones (the label would force the table
                          to scroll sideways); aria-label covers both. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={labels.viewMovements}
                        onClick={() => {
                          setSheetTarget({
                            variantId: variant._id,
                            label: variant.color
                              ? `${variant.size} / ${variant.color}`
                              : `${variant.size} / ${labels.noColor}`,
                            ...(variant.sku !== undefined
                              ? { sku: variant.sku }
                              : {}),
                            stock: qty,
                          });
                          setSheetOpen(true);
                        }}
                      >
                        <span className="hidden sm:inline">
                          {labels.viewMovements}
                        </span>
                        <HugeiconsIcon
                          icon={ChevronRightIcon}
                          strokeWidth={2}
                          className="size-4"
                        />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <VariantHistorySheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        productName={item.product.name}
        variant={sheetTarget ?? undefined}
        timezone={timezone}
      />
    </>
  );
}
