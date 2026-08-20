"use client";

import {
  Calculator01Icon,
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
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useShop } from "@/hooks/use-shop";
import { formatDateTime, formatMoney, getLang, t } from "@/lib/utils";

// T18 — Expenses (AGENTS.md). Every spend is a row; the day's total feeds
// the daily P/L report. Money is integer cents in the DB — display only here.

export default function ExpensesPage() {
  const user = useCurrentUser();
  const shop = useShop();
  const lang = getLang();

  // Search box value + debounced copy that actually drives the query.
  const [search, setSearch] = usePersistentState("expenses:search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [pageSize, setPageSize] = usePersistentState("expenses:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  const list = useQuery(
    api.expenses.list,
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

  const columns = useMemo<DataTableColumn<Doc<"expenses">>[]>(
    () => [
      {
        accessorKey: "spentAt",
        header: t().expenses.date,
        enableSorting: false,
        cell: ({ row }) =>
          formatDateTime(row.original.spentAt, shop?.timezone ?? "Asia/Phnom_Penh", lang),
      },
      {
        accessorKey: "category",
        header: t().expenses.category,
        enableSorting: false,
        cell: ({ row }) => row.original.category,
      },
      {
        accessorKey: "note",
        header: t().common.note,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="block max-w-64 truncate">{row.original.note ?? "—"}</span>
        ),
      },
      {
        accessorKey: "amount",
        header: t().expenses.amount,
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-medium">
            {formatMoney(row.original.amount, shop?.currency ?? "USD", lang)}
          </span>
        ),
      },
      {
        id: "actions",
        header: t().common.actions,
        enableSorting: false,
        cell: ({ row }) => (
          <Link
            href={`/expenses/${row.original._id}`}
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
      <PageToolbar icon={Calculator01Icon} title={t().nav.expenses}>
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
            placeholder={t().expenses.searchPlaceholder}
            aria-label={t().expenses.searchPlaceholder}
          />
        </InputGroup>
        <Link href="/expenses/new" className={buttonVariants()}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
          {t().expenses.addExpense}
        </Link>
      </PageToolbar>

      <div className="flex flex-col gap-4 p-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base font-medium">
              {t().expenses.todayTotal}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-heading text-2xl font-semibold">
              {list != null
                ? formatMoney(list.todayTotal, shop?.currency ?? "USD", lang)
                : "—"}
            </p>
          </CardContent>
        </Card>

        <DataTable
          columns={columns}
          data={list?.page ?? []}
          persistKey="expenses"
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
          cardRender={(expense) => (
            <Card>
              <CardHeader>
                <CardTitle>{expense.category}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {formatDateTime(expense.spentAt, shop?.timezone ?? "Asia/Phnom_Penh", lang)}
                </p>
              </CardHeader>
              <CardContent className="flex-row items-center justify-between">
                <span className="font-heading text-lg font-semibold">
                  {formatMoney(expense.amount, shop?.currency ?? "USD", lang)}
                </span>
                <Link
                  href={`/expenses/${expense._id}`}
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
