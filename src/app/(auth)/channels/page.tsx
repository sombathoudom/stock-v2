"use client";

import {
  Link01Icon,
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

// T8 — Sales channels list (AGENTS.md): the shop's selling pages. Every
// sale picks one of these; soft-delete keeps old orders pointing at them.

export default function ChannelsPage() {
  const user = useCurrentUser();

  // Search box value + debounced copy that actually drives the query.
  const [search, setSearch] = usePersistentState("channels:search", "");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const [pageSize, setPageSize] = usePersistentState("channels:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);

  const list = useQuery(
    api.channels.list,
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

  const columns = useMemo<DataTableColumn<Doc<"salesChannels">>[]>(
    () => [
      {
        accessorKey: "name",
        header: t().common.name,
        enableSorting: false,
        cell: ({ row }) => row.original.name,
      },
      {
        accessorKey: "type",
        header: t().channels.type,
        enableSorting: false,
        cell: ({ row }) => (
          <Badge variant="outline">
            {t().channels.types[row.original.type]}
          </Badge>
        ),
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
            href={`/channels/${row.original._id}`}
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
      <PageToolbar icon={Link01Icon} title={t().nav.channels}>
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
            placeholder={t().channels.searchPlaceholder}
            aria-label={t().channels.searchPlaceholder}
          />
        </InputGroup>
        <Link href="/channels/new" className={buttonVariants()}>
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
          {t().channels.addChannel}
        </Link>
      </PageToolbar>

      <div className="p-4">
        <DataTable
          columns={columns}
          data={list?.page ?? []}
          persistKey="channels"
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
          cardRender={(channel) => (
            <Card>
              <CardHeader>
                <CardTitle>{channel.name}</CardTitle>
                <p className="text-sm text-muted-foreground">
                  {t().channels.types[channel.type]}
                </p>
              </CardHeader>
              <CardContent className="flex-row items-center justify-between">
                <Badge variant={channel.active ? "default" : "secondary"}>
                  {channel.active ? t().common.active : t().common.inactive}
                </Badge>
                <Link
                  href={`/channels/${channel._id}`}
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
