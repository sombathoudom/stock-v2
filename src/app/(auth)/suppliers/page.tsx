"use client";

import {
  Contact01Icon,
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { t } from "@/lib/utils";

// T4 — Suppliers CRUD (AGENTS.md). Contact records for purchases; soft-delete
// only so purchase history keeps pointing at the same row.

export default function SuppliersPage() {
  const user = useCurrentUser();

  // Search box value + debounced copy that actually drives the query.
  const [search, setSearch] = usePersistentState("suppliers:search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [pageSize, setPageSize] = usePersistentState("suppliers:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  const list = useQuery(
    api.suppliers.list,
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

  const columns = useMemo<DataTableColumn<Doc<"suppliers">>[]>(
    () => [
      {
        accessorKey: "name",
        header: t().common.name,
        enableSorting: false,
        cell: ({ row }) => row.original.name,
      },
      {
        accessorKey: "phone",
        header: t().suppliers.phone,
        enableSorting: false,
        cell: ({ row }) => row.original.phone ?? "—",
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
            href={`/suppliers/${row.original._id}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} className="size-4" />
            {t().common.edit}
          </Link>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Contact01Icon} title={t().nav.suppliers}>
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
            placeholder={t().suppliers.searchPlaceholder}
            aria-label={t().suppliers.searchPlaceholder}
          />
        </InputGroup>
        <Link href="/suppliers/new" className={buttonVariants()}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
          {t().suppliers.addSupplier}
        </Link>
      </PageToolbar>

      <div className="p-4">
        <DataTable
          columns={columns}
          data={list?.page ?? []}
          persistKey="suppliers"
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
          cardRender={(supplier) => (
            <Card>
              <CardHeader>
                <CardTitle>{supplier.name}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {supplier.phone ?? "—"}
                </p>
              </CardHeader>
              <CardContent className="flex-row items-center justify-between">
                <Badge variant={supplier.active ? "default" : "secondary"}>
                  {supplier.active ? t().common.active : t().common.inactive}
                </Badge>
                <Link
                  href={`/suppliers/${supplier._id}`}
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
