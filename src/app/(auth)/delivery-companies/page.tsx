"use client";

import {
  DeliveryTruck01Icon,
  PencilEdit01Icon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/features/data-table/data-table";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { formatMoney, getLang, t } from "@/lib/utils";

// T9 — Delivery companies list (AGENTS.md). Contact records only — they
// receive the packages and never log in. The evening reconciliation screen
// (T17) groups today's orders by these companies.

export default function DeliveryCompaniesPage() {
  const user = useCurrentUser();
  const shop = useQuery(api.shop.get, user == null ? "skip" : {});

  // Search box value + debounced copy that actually drives the query.
  const [search, setSearch] = usePersistentState("deliveryCompanies:search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [pageSize, setPageSize] = usePersistentState("deliveryCompanies:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  const list = useQuery(
    api.deliveryCompanies.list,
    user == null
      ? "skip"
      : {
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
          search: debouncedSearch.trim() || undefined,
        },
  );

  // Changing the search or the page size restarts from page 1.
  function resetPages() {
    setPageIndex(0);
    setCursors([]);
  }

  const lang = getLang();
  const columns = useMemo<DataTableColumn<Doc<"deliveryCompanies">>[]>(
    () => [
      {
        accessorKey: "name",
        header: t().common.name,
        enableSorting: false,
        cell: ({ row }) => row.original.name,
      },
      {
        accessorKey: "phone",
        header: t().deliveryCompanies.phone,
        enableSorting: false,
        cell: ({ row }) => row.original.phone ?? "—",
      },
      {
        accessorKey: "defaultFee",
        header: t().deliveryCompanies.defaultFee,
        enableSorting: false,
        cell: ({ row }) =>
          formatMoney(row.original.defaultFee, shop?.currency ?? "USD", lang),
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
            href={`/delivery-companies/${row.original._id}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} className="size-4" />
            {t().common.edit}
          </Link>
        ),
      },
    ],
    [shop, lang],
  );

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={DeliveryTruck01Icon} title={t().nav.delivery}>
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
            placeholder={t().deliveryCompanies.searchPlaceholder}
            aria-label={t().deliveryCompanies.searchPlaceholder}
          />
        </InputGroup>
        <Link href="/delivery-companies/new" className={buttonVariants()}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
          {t().deliveryCompanies.addCompany}
        </Link>
      </PageToolbar>

      <div className="p-4">
        {shop != null && !shop.deliveryEnabled && (
          <Card className="mb-4 border-dashed">
            <CardHeader>
              <CardTitle className="text-base">
                {t().deliveryCompanies.moduleOffTitle}
              </CardTitle>
              <CardDescription>
                {t().deliveryCompanies.moduleOffBody}
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        <DataTable
          columns={columns}
          data={list?.page ?? []}
          persistKey="deliveryCompanies"
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
          cardRender={(company) => (
            <Card>
              <CardHeader>
                <CardTitle>{company.name}</CardTitle>
                <CardDescription>{company.phone ?? "—"}</CardDescription>
              </CardHeader>
              <CardContent className="flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">
                    {formatMoney(company.defaultFee, shop?.currency ?? "USD", lang)}
                  </Badge>
                  <Badge variant={company.active ? "default" : "secondary"}>
                    {company.active ? t().common.active : t().common.inactive}
                  </Badge>
                </div>
                <Link
                  href={`/delivery-companies/${company._id}`}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} className="size-4" />
                  {t().common.edit}
                </Link>
              </CardContent>
            </Card>
          )}
        />
      </div>
    </div>
  );
}
