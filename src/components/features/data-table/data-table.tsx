"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Table01Icon,
} from "@hugeicons/core-free-icons";
import {
  columnOrderingFeature,
  columnVisibilityFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type Column,
  type ColumnDef,
  type ColumnOrderState,
  type ColumnVisibilityState,
  type OnChangeFn,
  type RowData,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import { Fragment, useMemo, useState } from "react";

import { usePersistentState } from "@/hooks/use-persistent-state";
import { cn, t } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

// THE shared table for every list in the app (AGENTS.md: one DataTable).
// Built on TanStack Table v9. Server-side everything: sorting and pagination
// are controlled props driven by the Convex query of the parent page —
// no client-side row models are registered. Column reordering (drag headers)
// and column visibility are persisted in localStorage per table.

// Opt-in per-column className hooks (applied to this column's th/td) — used
// for breakpoint hiding, e.g. "Last updated" hidden below lg on tablets.
// Declared as the features object's `columnMeta` slot (TanStack Table v9's
// ExtractColumnMeta pattern) so `columnDef.meta` is typed right here, with
// no global ColumnMeta module augmentation to drift from the library's.
export type DataTableColumnMeta = {
  headerClassName?: string;
  cellClassName?: string;
};

const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  columnOrderingFeature,
  columnVisibilityFeature,
  // Type-only slot: every ColumnDef built through DataTableColumn<T> gets
  // meta?: DataTableColumnMeta.
  columnMeta: {} as DataTableColumnMeta,
});

export type DataTableColumn<TData extends RowData> = ColumnDef<
  typeof dataTableFeatures,
  TData
>;

export type DataTableProps<TData extends RowData> = {
  columns: DataTableColumn<TData>[];
  data: TData[];
  /** Unique key so column order/visibility persist per table across reloads. */
  persistKey: string;
  /** Stable row id; defaults to _id when present. */
  getRowId?: (row: TData) => string;
  /** Card rendering for phones — the table is hidden below md. */
  cardRender?: (row: TData) => React.ReactNode;
  loading?: boolean;
  /** Whole-row click on the desktop table (cursor + role=link + Enter/Space).
   * Nested action buttons must stopPropagation. */
  onRowClick?: (row: TData) => void;
  /** Pin the header; the body scrolls inside a bounded-height container. */
  stickyHeader?: boolean;
  /** Suppress the built-in columns menu (the page hosts its own). */
  hideBuiltInColumnsMenu?: boolean;
  /** Controlled column visibility — the caller persists it (e.g. a Columns
   * menu in the page header). Defaults to the internal per-table store. */
  columnVisibility?: ColumnVisibilityState;
  onColumnVisibilityChange?: OnChangeFn<ColumnVisibilityState>;
  // Server-side sorting (controlled). When omitted, sorting works in-memory.
  sorting?: SortingState;
  onSortingChange?: (sorting: SortingState) => void;
  // Server-side pagination (controlled). When omitted, no footer renders.
  totalCount?: number;
  /** 0-based. */
  pageIndex?: number;
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
  onPageChange?: (direction: "prev" | "next") => void;
};

function defaultGetRowId<TData extends RowData>(row: TData, index: number) {
  const id = (row as { _id?: string } | null)?._id;
  return id ?? String(index);
}

/** Column id, whether defined by id or accessorKey shorthand. */
export function columnIdOf<TData extends RowData>(col: DataTableColumn<TData>): string {
  return col.id ?? (col as { accessorKey?: string }).accessorKey ?? "";
}

/** Dropdown label: string headers as-is, everything else falls back to the id. */
export function columnLabelOf<TData extends RowData, TValue>(
  col: Column<typeof dataTableFeatures, TData, TValue>,
): string {
  const header = col.columnDef.header;
  return typeof header === "string" && header.length > 0 ? header : col.id;
}

/** Same label logic for a column DEF — the page's own Columns menu. */
export function columnLabelOfDef<TData extends RowData>(
  col: DataTableColumn<TData>,
): string {
  return typeof col.header === "string" && col.header.length > 0
    ? col.header
    : columnIdOf(col);
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  persistKey,
  getRowId,
  cardRender,
  loading = false,
  onRowClick,
  stickyHeader = false,
  hideBuiltInColumnsMenu = false,
  columnVisibility,
  onColumnVisibilityChange,
  sorting,
  onSortingChange,
  totalCount,
  pageIndex = 0,
  pageSize = 20,
  onPageSizeChange,
  onPageChange,
}: DataTableProps<TData>) {
  // UI preferences persist in the browser (column order & visibility).
  const [persistedOrder, setPersistedOrder] = usePersistentState<ColumnOrderState>(
    `dt:${persistKey}:order`,
    [],
  );
  const [persistedVisibility, setPersistedVisibility] = usePersistentState<ColumnVisibilityState>(
    `dt:${persistKey}:visibility`,
    {},
  );
  // Visibility may be controlled by the page (e.g. a Columns menu in the
  // page header) — the internal per-table store is the uncontrolled path.
  const isVisibilityControlled =
    columnVisibility !== undefined && onColumnVisibilityChange !== undefined;
  const visibilityState = isVisibilityControlled
    ? columnVisibility
    : persistedVisibility;

  const handleVisibilityChange: OnChangeFn<ColumnVisibilityState> = (
    updater: Updater<ColumnVisibilityState>,
  ) => {
    const next = typeof updater === "function" ? updater(visibilityState) : updater;
    if (isVisibilityControlled) onColumnVisibilityChange(next);
    else setPersistedVisibility(next);
  };

  // Sort state: controlled by the server via props, or kept locally.
  const isSortingControlled = sorting !== undefined && onSortingChange !== undefined;
  const [internalSorting, setInternalSorting] = useState<SortingState>([]);
  const sortingState = isSortingControlled ? sorting : internalSorting;

  // Effective column order = persisted order, pruned to existing columns,
  // with any new columns appended in definition order.
  const defaultOrder = useMemo(
    () => columns.map(columnIdOf).filter(Boolean),
    [columns],
  );
  const effectiveOrder = useMemo(() => {
    const merged = persistedOrder.filter((id) => defaultOrder.includes(id));
    for (const id of defaultOrder) if (!merged.includes(id)) merged.push(id);
    return merged;
  }, [defaultOrder, persistedOrder]);

  const handleSortingChange: OnChangeFn<SortingState> = (updater: Updater<SortingState>) => {
    const next = typeof updater === "function" ? updater(sortingState) : updater;
    if (isSortingControlled) onSortingChange(next);
    else setInternalSorting(next);
  };

  const table = useTable({
    features: dataTableFeatures,
    data,
    columns,
    getRowId: getRowId ?? defaultGetRowId,
    manualSorting: true,
    state: {
      ...(isSortingControlled ? { sorting: sortingState } : {}),
      columnOrder: effectiveOrder,
      columnVisibility: visibilityState,
    },
    onSortingChange: handleSortingChange,
    onColumnOrderChange: setPersistedOrder,
    onColumnVisibilityChange: handleVisibilityChange,
  });

  // Header drag-and-drop for column reordering (desktop only — the table is
  // hidden on phones).
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  function onDrop() {
    if (dragId && overId && dragId !== overId) {
      const from = effectiveOrder.indexOf(dragId);
      const to = effectiveOrder.indexOf(overId);
      if (from >= 0 && to >= 0) {
        const next = [...effectiveOrder];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        table.setColumnOrder(next);
      }
    }
    setDragId(null);
    setOverId(null);
  }

  const visibleColumns = table.getVisibleLeafColumns();
  const hideableColumns = table.getAllLeafColumns().filter((col) => col.getCanHide());
  const rows = table.getRowModel().rows;
  const pageCount =
    totalCount !== undefined ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1;

  return (
    <div>
      {/* Desktop table (md+) */}
      <div className="hidden md:block">
        {!hideBuiltInColumnsMenu && hideableColumns.length > 0 && (
          <div className="mb-2 flex justify-end px-1">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="outline" size="sm" />}
              >
                <HugeiconsIcon icon={Table01Icon} strokeWidth={2} className="size-4" />
                {t().common.columns}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Base UI group parts (GroupLabel + checkbox items) must live
                    inside a Menu.Group — rendered bare they throw
                    "MenuGroupContext is missing". */}
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t().common.columns}</DropdownMenuLabel>
                  {hideableColumns.map((col) => (
                    <DropdownMenuCheckboxItem
                      key={col.id}
                      checked={col.getIsVisible()}
                      onCheckedChange={(checked) => col.toggleVisibility(checked)}
                    >
                      {columnLabelOf(col)}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => table.toggleAllColumnsVisible(true)}>
                  {t().common.showAll}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        <div
          className={cn(
            "overflow-hidden rounded-md border",
            // Bounded scroll container so a sticky thead actually sticks.
            stickyHeader && "max-h-[65dvh] overflow-x-auto overflow-y-auto",
          )}
        >
          {/* The inner table must NOT be its own scroll container or the
              sticky header silently no-ops (overflow-x forces overflow-y). */}
          <Table containerClassName={stickyHeader ? "overflow-visible" : undefined}>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const col = header.column;
                    const canSort = col.getCanSort();
                    const sorted = col.getIsSorted();
                    return (
                      <TableHead
                        key={header.id}
                        colSpan={header.colSpan}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = "move";
                          setDragId(col.id);
                        }}
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (col.id !== dragId) setOverId(col.id);
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          onDrop();
                        }}
                        onDragEnd={() => {
                          setDragId(null);
                          setOverId(null);
                        }}
                        className={cn(
                          "cursor-move select-none",
                          dragId === col.id && "opacity-50",
                          overId === col.id && dragId !== col.id && "border-s-2 border-primary",
                          // Opaque background required — rows scroll under it.
                          stickyHeader && "sticky top-0 z-10 bg-background",
                          col.columnDef.meta?.headerClassName,
                        )}
                      >
                        {header.isPlaceholder ? null : canSort ? (
                          <button
                            type="button"
                            onClick={col.getToggleSortingHandler()}
                            className="inline-flex items-center gap-1"
                          >
                            <table.FlexRender header={header} />
                            {sorted === "asc" && (
                              <HugeiconsIcon
                                icon={ArrowUp01Icon}
                                strokeWidth={2}
                                className="size-3.5 shrink-0"
                              />
                            )}
                            {sorted === "desc" && (
                              <HugeiconsIcon
                                icon={ArrowDown01Icon}
                                strokeWidth={2}
                                className="size-3.5 shrink-0"
                              />
                            )}
                          </button>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {visibleColumns.map((col) => (
                      <TableCell key={col.id}>
                        <Skeleton className="h-4 w-16" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={visibleColumns.length}
                    className="py-10 text-center text-muted-foreground"
                  >
                    {t().common.noResults}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow
                    key={row.id}
                    {...(onRowClick
                      ? {
                          className: "cursor-pointer",
                          role: "link",
                          tabIndex: 0,
                          onClick: () => onRowClick(row.original),
                          onKeyDown: (e: React.KeyboardEvent) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onRowClick(row.original);
                            }
                          },
                        }
                      : {})}
                  >
                    {row.getAllCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cn(cell.column.columnDef.meta?.cellClassName)}
                      >
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Phone: card list instead of the table */}
      {cardRender != null && (
        <div className="flex flex-col gap-2 p-2 md:hidden">
          {loading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-md" />
            ))
          ) : rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t().common.noResults}
            </p>
          ) : (
            rows.map((row) => (
              <Fragment key={row.id}>{cardRender(row.original)}</Fragment>
            ))
          )}
        </div>
      )}

      {/* Server pagination footer: page size 20 / 50 / 100, prev / next */}
      {totalCount !== undefined && (
        <div className="sticky bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 flex flex-col items-center gap-2 border-t bg-background/95 px-3 py-3 backdrop-blur sm:flex-row sm:justify-between sm:px-4 sm:py-2 md:static md:bg-background md:backdrop-blur-none">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{t().common.rowsPerPage}</span>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => onPageSizeChange?.(Number(value))}
              // Base UI shows the RAW value in the trigger without this map.
              items={{ "20": "20", "50": "50", "100": "100" }}
            >
              <SelectTrigger size="sm" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[20, 50, 100].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Button
              variant="outline"
              size="icon-sm"
              disabled={pageIndex === 0 || loading}
              onClick={() => onPageChange?.("prev")}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-4" />
            </Button>
            <span className="text-muted-foreground">
              {t().common.page} {pageIndex + 1} {t().common.of} {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={pageIndex + 1 >= pageCount || loading}
              onClick={() => onPageChange?.("next")}
            >
              <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
