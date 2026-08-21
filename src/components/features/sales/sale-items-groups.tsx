"use client";

import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  PackageReceive01Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";

import type { FunctionReturnType } from "convex/server";
import type { Id } from "@convex/_generated/dataModel";
import { api } from "@convex/_generated/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney, getLang, t } from "@/lib/utils";
import {
  groupSaleItems,
  type SaleItemGroup,
} from "@/lib/sale-item-groups";

// The Sale Detail item list, GROUPED by variant for readability. The lines
// themselves stay separate everywhere else (database, Edit Sale); here they
// are summarized into one row per variant with an expandable "sale lines"
// view that shows each immutable line with its own quantities, price,
// discount, subtotal and actions. Group totals are a pure projection of the
// lines (src/lib/sale-item-groups.ts) — nothing here recomputes business
// values and nothing writes.

type SaleDetailItem = NonNullable<
  FunctionReturnType<typeof api.sales.getDetail>
>["items"][number];
type SaleDetailItems = SaleDetailItem[];

export function SaleItemGroups({
  items,
  currency,
  adjustable,
  onAdjust,
  onReturn,
}: {
  items: SaleDetailItems;
  currency: string;
  adjustable: boolean;
  /** Opens the door-adjust dialog (adjusts delivered quantities). */
  onAdjust: (line: SaleDetailItem) => void;
  /** Opens the per-line return dialog. */
  onReturn: (line: SaleDetailItem) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = groupSaleItems(
    items.map(({ item, variant, product }) => ({
      saleItemId: item._id,
      variantId: variant._id,
      productName: product.name,
      variantLabel: variant.color
        ? `${variant.size} · ${variant.color}`
        : variant.size,
      sku: variant.sku,
      imageStorageId: product.imageStorageId,
      unitPrice: item.unitPrice,
      discount: item.discount,
      qtyOrdered: item.qtyOrdered,
      qtyDelivered: item.qtyDelivered,
      qtyCancelled: item.qtyCancelled,
      qtyReturned: item.qtyReturned,
    }))
  );

  function toggle(groupKey: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Desktop: one grouped row per variant, expandable to its lines. */}
      <div className="hidden overflow-x-auto rounded-md border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t().sales.edit.colItem}</TableHead>
              <TableHead className="text-right">{t().sales.itemQtys.ordered}</TableHead>
              <TableHead className="text-right">{t().sales.itemQtys.cancelled}</TableHead>
              <TableHead className="text-right">{t().sales.itemQtys.returned}</TableHead>
              <TableHead className="text-right">{t().sales.itemQtys.withCustomer}</TableHead>
              <TableHead className="text-right">{t().sales.price}</TableHead>
              <TableHead className="text-right">{t().sales.total}</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <GroupRows
                key={group.variantId}
                group={group}
                open={expanded.has(group.variantId)}
                currency={currency}
                adjustable={adjustable}
                onToggle={() => toggle(group.variantId)}
                onAdjust={onAdjust}
                onReturn={onReturn}
                items={items}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Phone: compact grouped cards with state chips. */}
      <div className="flex flex-col gap-2 md:hidden">
        {groups.map((group) => (
          <GroupCard
            key={group.variantId}
            group={group}
            open={expanded.has(group.variantId)}
            currency={currency}
            adjustable={adjustable}
            onToggle={() => toggle(group.variantId)}
            onAdjust={onAdjust}
            onReturn={onReturn}
            items={items}
          />
        ))}
      </div>
    </div>
  );
}

/** "1 awaiting", "2 cancelled", "1 returned", "1 with customer" chips. */
function StateChips({ group }: { group: SaleItemGroup }) {
  const labels = t().sales;
  const chips: string[] = [];
  if (group.awaitingDelivery > 0)
    chips.push(labels.stateAwaiting.replace("{qty}", String(group.awaitingDelivery)));
  if (group.withCustomer > 0)
    chips.push(labels.stateWithCustomer.replace("{qty}", String(group.withCustomer)));
  if (group.cancelled > 0)
    chips.push(labels.stateCancelled.replace("{qty}", String(group.cancelled)));
  if (group.returned > 0)
    chips.push(labels.stateReturned.replace("{qty}", String(group.returned)));
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((chip) => (
        <Badge key={chip} variant="secondary" className="text-xs font-normal">
          {chip}
        </Badge>
      ))}
    </span>
  );
}

/** Right-aligned numeric cell class; a ZERO value is muted so the
 * non-zero quantities and totals (and the row state badge) are what
 * catch the eye. */
function qtyClass(v: number): string {
  return `text-right tabular-nums${v === 0 ? " text-muted-foreground" : ""}`;
}

/** One "Label: value" pair on the mobile line card — the value pops when it
 * is NOT zero, so returned ($0) lines stay quiet and billed lines stand out. */
function LineValue({
  label,
  value,
  zero,
}: {
  label: string;
  value: string | number;
  zero: boolean;
}) {
  return (
    <span>
      {label}: <span className={zero ? "" : "text-foreground"}>{value}</span>
    </span>
  );
}

function PriceCell({ group, currency }: { group: SaleItemGroup; currency: string }) {
  if (group.multiplePrices) {
    return (
      <span className="text-muted-foreground">
        {t().sales.groupMultiplePrices}
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      {formatMoney(group.unitPrice!, currency, getLang())}
    </span>
  );
}

function ExpandButton({
  group,
  open,
  onToggle,
}: {
  group: SaleItemGroup;
  open: boolean;
  onToggle: () => void;
}) {
  const labels = t().sales;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? labels.groupHideDetails : labels.groupShowDetails} — ${group.productName} ${group.variantLabel}`}
      className="h-8 gap-1.5 px-2 text-xs"
    >
      {labels.groupLines.replace("{n}", String(group.lines.length))}
      <HugeiconsIcon
        icon={open ? ArrowUp01Icon : ArrowDown01Icon}
        strokeWidth={2}
        className="size-3.5"
      />
    </Button>
  );
}

/** The per-line detail rows inside an expanded group (desktop). */
function LineRows({
  group,
  currency,
  adjustable,
  onAdjust,
  onReturn,
  items,
}: {
  group: SaleItemGroup;
  currency: string;
  adjustable: boolean;
  onAdjust: (line: SaleDetailItem) => void;
  onReturn: (line: SaleDetailItem) => void;
  items: SaleDetailItems;
}) {
  const byId = new Map(items.map((l) => [l.item._id, l]));
  const labels = t().sales;
  return (
    <TableRow className="bg-muted/30">
      <TableCell colSpan={8} className="p-0">
        <div className="border-t px-4 py-2">
          <Table>
            <TableHeader>
              <TableRow className="text-xs">
                <TableHead>{labels.itemQtys.saleLineSku}</TableHead>
                <TableHead>{labels.itemQtys.ordered}</TableHead>
                <TableHead className="text-right">{labels.itemQtys.delivered}</TableHead>
                <TableHead className="text-right">{labels.itemQtys.cancelled}</TableHead>
                <TableHead className="text-right">{labels.itemQtys.returned}</TableHead>
                <TableHead className="text-right">{labels.itemQtys.withCustomer}</TableHead>
                <TableHead className="text-right">{labels.price}</TableHead>
                <TableHead className="text-right">{labels.discount}</TableHead>
                <TableHead className="text-right">{labels.total}</TableHead>
                <TableHead className="text-right">{t().common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {group.lines.map((line) => {
                const original = byId.get(line.line.saleItemId as Id<"saleItems">);
                return (
                  <TableRow key={line.line.saleItemId} className="text-sm">
                    <TableCell>
                      <div className="flex flex-col items-start gap-1">
                        <span className="text-muted-foreground">
                          {line.line.sku ?? line.line.variantLabel}
                        </span>
                        {line.line.qtyReturned > 0 ? (
                          <Badge
                            variant="secondary"
                            className="text-xs font-normal"
                          >
                            {labels.lineStateReturnedSellable}
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className={qtyClass(line.line.qtyOrdered)}>
                      {line.line.qtyOrdered}
                    </TableCell>
                    <TableCell className={qtyClass(line.line.qtyDelivered)}>
                      {line.line.qtyDelivered}
                    </TableCell>
                    <TableCell className={qtyClass(line.line.qtyCancelled)}>
                      {line.line.qtyCancelled}
                    </TableCell>
                    <TableCell className={qtyClass(line.line.qtyReturned)}>
                      {line.line.qtyReturned}
                    </TableCell>
                    <TableCell className={qtyClass(line.withCustomer)}>
                      {line.withCustomer}
                    </TableCell>
                    <TableCell className={qtyClass(line.line.unitPrice)}>
                      {formatMoney(line.line.unitPrice, currency, getLang())}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {(line.line.discount ?? 0) > 0
                        ? `−${formatMoney(line.line.discount!, currency, getLang())}`
                        : "—"}
                    </TableCell>
                    <TableCell className={qtyClass(line.subtotal)}>
                      {formatMoney(line.subtotal, currency, getLang())}
                    </TableCell>
                    <TableCell className="text-right">
                      {adjustable && original ? (
                        <div className="flex justify-end gap-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="size-9"
                            onClick={() => onAdjust(original)}
                            aria-label={`${labels.adjust} — ${group.productName} ${line.line.variantLabel}`}
                          >
                            <HugeiconsIcon
                              icon={SlidersHorizontalIcon}
                              strokeWidth={2}
                              className="size-4"
                            />
                          </Button>
                          {line.withCustomer > 0 ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-9"
                              onClick={() => onReturn(original)}
                              aria-label={`${labels.returnItem} — ${group.productName} ${line.line.variantLabel}`}
                            >
                              <HugeiconsIcon
                                icon={PackageReceive01Icon}
                                strokeWidth={2}
                                className="size-4"
                              />
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </TableCell>
    </TableRow>
  );
}

// --- desktop grouped row + expandable detail ---

function GroupRows({
  group,
  open,
  currency,
  adjustable,
  onToggle,
  onAdjust,
  onReturn,
  items,
}: {
  group: SaleItemGroup;
  open: boolean;
  currency: string;
  adjustable: boolean;
  onToggle: () => void;
  onAdjust: (line: SaleDetailItem) => void;
  onReturn: (line: SaleDetailItem) => void;
  items: SaleDetailItems;
}) {
  return (
    <>
      <TableRow>
        <TableCell>
          <span className="font-medium">
            {group.productName} — {group.variantLabel}
          </span>
          <span className="block text-xs text-muted-foreground">
            {group.sku ? `${group.sku} · ` : ""}
            {t().sales.groupLines.replace("{n}", String(group.lines.length))}
          </span>
          <StateChips group={group} />
        </TableCell>
        <TableCell className="text-right tabular-nums">{group.ordered}</TableCell>
        <TableCell className="text-right tabular-nums">{group.cancelled}</TableCell>
        <TableCell className="text-right tabular-nums">{group.returned}</TableCell>
        <TableCell className="text-right tabular-nums">{group.withCustomer}</TableCell>
        <TableCell className="text-right">
          <PriceCell group={group} currency={currency} />
        </TableCell>
        <TableCell className="text-right font-medium tabular-nums">
          {formatMoney(group.subtotal, currency, getLang())}
        </TableCell>
        <TableCell className="text-right">
          <ExpandButton group={group} open={open} onToggle={onToggle} />
        </TableCell>
      </TableRow>
      {group.integrity.length > 0 ? (
        <TableRow>
          <TableCell colSpan={8} className="text-xs text-destructive">
            {t().sales.groupIntegrity}
          </TableCell>
        </TableRow>
      ) : null}
      {open ? (
        <LineRows
          group={group}
          currency={currency}
          adjustable={adjustable}
          onAdjust={onAdjust}
          onReturn={onReturn}
          items={items}
        />
      ) : null}
    </>
  );
}

// --- mobile compact grouped card ---

function GroupCard({
  group,
  open,
  currency,
  adjustable,
  onToggle,
  onAdjust,
  onReturn,
  items,
}: {
  group: SaleItemGroup;
  open: boolean;
  currency: string;
  adjustable: boolean;
  onToggle: () => void;
  onAdjust: (line: SaleDetailItem) => void;
  onReturn: (line: SaleDetailItem) => void;
  items: SaleDetailItems;
}) {
  const labels = t().sales;
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-medium">
            {group.productName} — {group.variantLabel}
          </p>
          {group.sku ? (
            <p className="text-xs text-muted-foreground">{group.sku}</p>
          ) : null}
          <div className="mt-1">
            <StateChips group={group} />
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-semibold tabular-nums">
            {formatMoney(group.subtotal, currency, getLang())}
          </p>
          <ExpandButton group={group} open={open} onToggle={onToggle} />
        </div>
      </div>
      {group.integrity.length > 0 ? (
        <p className="mt-2 text-xs text-destructive">{labels.groupIntegrity}</p>
      ) : null}
      {open ? (
        <div className="mt-2 flex flex-col divide-y border-t">
          {group.lines.map((line) => {
            const original = items.find((l) => l.item._id === line.line.saleItemId);
            return (
              <div
                key={line.line.saleItemId}
                className="flex flex-col gap-1 py-2 text-sm"
              >
                <div className="flex items-center justify-between">
                  <div className="flex flex-col items-start gap-1">
                    <span className="text-muted-foreground">
                      {line.line.sku ?? line.line.variantLabel}
                    </span>
                    {line.line.qtyReturned > 0 ? (
                      <Badge
                        variant="secondary"
                        className="text-xs font-normal"
                      >
                        {labels.lineStateReturnedSellable}
                      </Badge>
                    ) : null}
                  </div>
                  <span
                    className={`font-medium tabular-nums${
                      line.subtotal === 0 ? " text-muted-foreground" : ""
                    }`}
                  >
                    {formatMoney(line.subtotal, currency, getLang())}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <LineValue
                    label={labels.itemQtys.ordered}
                    value={line.line.qtyOrdered}
                    zero={line.line.qtyOrdered === 0}
                  />
                  <LineValue
                    label={labels.itemQtys.delivered}
                    value={line.line.qtyDelivered}
                    zero={line.line.qtyDelivered === 0}
                  />
                  <LineValue
                    label={labels.itemQtys.cancelled}
                    value={line.line.qtyCancelled}
                    zero={line.line.qtyCancelled === 0}
                  />
                  <LineValue
                    label={labels.itemQtys.returned}
                    value={line.line.qtyReturned}
                    zero={line.line.qtyReturned === 0}
                  />
                  <LineValue
                    label={labels.itemQtys.withCustomer}
                    value={line.withCustomer}
                    zero={line.withCustomer === 0}
                  />
                  <LineValue
                    label={labels.price}
                    value={formatMoney(line.line.unitPrice, currency, getLang())}
                    zero={line.line.unitPrice === 0}
                  />
                  {(line.line.discount ?? 0) > 0 ? (
                    <span>
                      {labels.discount}: −
                      {formatMoney(line.line.discount!, currency, getLang())}
                    </span>
                  ) : null}
                </div>
                {adjustable && original ? (
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9"
                      onClick={() => onAdjust(original)}
                      aria-label={`${labels.adjust} — ${group.productName} ${line.line.variantLabel}`}
                    >
                      {labels.adjust}
                    </Button>
                    {line.withCustomer > 0 ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9"
                        onClick={() => onReturn(original)}
                        aria-label={`${labels.returnItem} — ${group.productName} ${line.line.variantLabel}`}
                      >
                        {labels.returnItem}
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
