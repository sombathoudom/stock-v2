"use client";

import {
  PencilEdit01Icon,
  PlusSignIcon,
  Search01Icon,
  TagsIcon,
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

// T2 — Categories CRUD (AGENTS.md). Soft-delete only: turning a category off
// hides it from product forms, nothing is ever hard-deleted.

export default function CategoriesPage() {
  const user = useCurrentUser();

  // Search box value + debounced copy that actually drives the query.
  const [search, setSearch] = usePersistentState("categories:search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [pageSize, setPageSize] = usePersistentState("categories:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  const list = useQuery(
    api.categories.list,
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

  const columns = useMemo<DataTableColumn<Doc<"categories">>[]>(
    () => [
      {
        accessorKey: "name",
        header: t().common.name,
        enableSorting: false,
        cell: ({ row }) => row.original.name,
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
            href={`/categories/${row.original._id}`}
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
      <PageToolbar icon={TagsIcon} title={t().nav.categories}>
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
            placeholder={t().categories.searchPlaceholder}
            aria-label={t().categories.searchPlaceholder}
          />
        </InputGroup>
        <Link href="/categories/new" className={buttonVariants()}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
          {t().categories.addCategory}
        </Link>
      </PageToolbar>

      <div className="p-4">
        <DataTable
          columns={columns}
          data={list?.page ?? []}
          persistKey="categories"
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
          cardRender={(category) => (
            <Card>
              <CardHeader>
                <CardTitle>{category.name}</CardTitle>
              </CardHeader>
              <CardContent className="flex-row items-center justify-between">
                <Badge variant={category.active ? "default" : "secondary"}>
                  {category.active ? t().common.active : t().common.inactive}
                </Badge>
                <Link
                  href={`/categories/${category._id}`}
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
