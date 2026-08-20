"use client";

import {
  Image01Icon,
  PencilEdit01Icon,
  PlusSignIcon,
  Search01Icon,
  Shirt01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/features/data-table/data-table";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { formatMoney, imageUrl, t } from "@/lib/utils";

// T3 — Products list (AGENTS.md). Search + category filter live in the
// header; the shared DataTable shows the catalog with pagination.

export default function ProductsPage() {
  const user = useCurrentUser();
  const shop = useQuery(api.shop.get, user == null ? "skip" : {});
  const categoriesQuery = useQuery(api.categories.listAll, user == null ? "skip" : {});
  const currency = shop?.currency ?? "USD";

  // Search box value + debounced copy that actually drives the query.
  const [search, setSearch] = usePersistentState("products:search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [categoryFilter, setCategoryFilter] = usePersistentState(
    "products:categoryFilter",
    "all"
  );
  const [pageSize, setPageSize] = usePersistentState("products:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  const list = useQuery(
    api.products.list,
    user == null
      ? "skip"
      : {
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
          search: debouncedSearch.trim() || undefined,
          categoryId:
            categoryFilter !== "all" ? (categoryFilter as Doc<"categories">["_id"]) : undefined,
        },
  );

  // Changing the search, the category, or the page size restarts from page 1.
  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  const categoryName = useCallback(
    (id: string | undefined) =>
      (categoriesQuery ?? []).find((c) => c._id === id)?.name ?? "—",
    [categoriesQuery],
  );

  const columns = useMemo<DataTableColumn<Doc<"products">>[]>(
    () => [
      {
        id: "image",
        header: t().products.photo,
        enableSorting: false,
        cell: ({ row }) =>
          row.original.imageStorageId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl(row.original.imageStorageId)}
              alt={row.original.name}
              className="size-9 rounded-md border object-cover"
            />
          ) : (
            <span className="flex size-9 items-center justify-center rounded-md border bg-muted text-muted-foreground">
              <HugeiconsIcon icon={Image01Icon} strokeWidth={2} className="size-4" />
            </span>
          ),
      },
      {
        accessorKey: "name",
        header: t().common.name,
        enableSorting: false,
        cell: ({ row }) => row.original.name,
      },
      {
        id: "category",
        header: t().products.category,
        enableSorting: false,
        cell: ({ row }) => categoryName(row.original.categoryId),
      },
      {
        accessorKey: "defaultPrice",
        header: t().products.priceCol,
        enableSorting: false,
        cell: ({ row }) => formatMoney(row.original.defaultPrice, currency),
      },
      {
        accessorKey: "active",
        header: t().common.active,
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant={row.original.active ? "default" : "secondary"}>
            {row.original.active ? t().common.active : t().common.inactive}
          </Badge>
        ),
      },
      {
        id: "actions",
        header: t().common.actions,
        enableSorting: false,
        cell: ({ row }) => (
          // Base UI Button render= needs a native <button> — links use the
          // button variant classes directly on an <a> instead.
          <Link
            href={`/products/${row.original._id}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} className="size-4" />
            {t().common.edit}
          </Link>
        ),
      },
    ],
    [categoryName, currency]
  );

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Shirt01Icon} title={t().nav.products}>
        <InputGroup className="w-full sm:w-64">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              resetPages();
            }}
            placeholder={t().products.searchPlaceholder}
            aria-label={t().products.searchPlaceholder}
          />
        </InputGroup>
        <Select
          value={categoryFilter}
          // Base UI shows the RAW value in the trigger without this map.
          items={{
            all: t().products.allCategories,
            ...Object.fromEntries((categoriesQuery ?? []).map((c) => [c._id, c.name])),
          }}
          onValueChange={(value) => {
            setCategoryFilter(value ?? "all");
            resetPages();
          }}
        >
          <SelectTrigger className="w-40" aria-label={t().products.category}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t().products.allCategories}</SelectItem>
            {(categoriesQuery ?? []).map((c) => (
              <SelectItem key={c._id} value={c._id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Link href="/products/new" className={buttonVariants()}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
          {t().products.addProduct}
        </Link>
      </PageToolbar>

      <div className="p-4">
        <DataTable
          columns={columns}
          data={list?.page ?? []}
          persistKey="products"
          loading={list === undefined}
          totalCount={list?.total}
          pageIndex={pageIndex}
          pageSize={pageSize}
          onPageSizeChange={(size) => {
            setPageSize(size);
            resetPages();
          }}
          onPageChange={(direction) => {
            if (direction === "prev") {
              setPageIndex((i) => Math.max(0, i - 1));
            } else if (list?.continueCursor) {
              setCursors((c) =>
                c[pageIndex] === undefined ? [...c, list.continueCursor] : c,
              );
              setPageIndex((i) => i + 1);
            }
          }}
          cardRender={(product) => (
            <Card>
              <CardHeader className="flex-row items-center gap-3">
                {product.imageStorageId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={imageUrl(product.imageStorageId)}
                    alt={product.name}
                    className="size-12 rounded-md border object-cover"
                  />
                ) : (
                  <span className="flex size-12 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                    <HugeiconsIcon icon={Image01Icon} strokeWidth={2} className="size-5" />
                  </span>
                )}
                <div className="min-w-0">
                  <CardTitle className="truncate text-base">{product.name}</CardTitle>
                  <p className="text-xs text-muted-foreground">
                    {categoryName(product.categoryId)}
                  </p>
                </div>
              </CardHeader>
              <CardContent className="flex-row items-center justify-between">
                <span className="font-medium">
                  {formatMoney(product.defaultPrice, currency)}
                </span>
                <div className="flex items-center gap-2">
                  <Badge variant={product.active ? "default" : "secondary"}>
                    {product.active ? t().common.active : t().common.inactive}
                  </Badge>
                  <Link
                    href={`/products/${product._id}`}
                    className={buttonVariants({ variant: "outline", size: "sm" })}
                  >
                    <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} className="size-4" />
                    {t().common.edit}
                  </Link>
                </div>
              </CardContent>
            </Card>
          )}
        />
      </div>
    </div>
  );
}
