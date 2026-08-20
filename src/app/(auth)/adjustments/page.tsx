"use client";

import { ClipboardCheckIcon, RotateCwSquareIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import { type Language } from "@/config/labels";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useShop } from "@/hooks/use-shop";
import { formatDateTime, getLang, t, toastError } from "@/lib/utils";

// T22 — Stock adjustments + stocktake (AGENTS.md). Quick manual in/out per
// variant with a reason note (damaged, found, giveaway…) and a full
// stocktake (count vs system). Both write ledger rows server-side — the
// client only ever sends ids, quantities and intents; the server re-checks
// stock in the same transaction, so oversell is impossible.

type StocktakeVariant = NonNullable<
  FunctionReturnType<typeof api.adjustments.stocktakeList>
>[number];
type RecentChange = NonNullable<FunctionReturnType<typeof api.adjustments.recentChanges>>[number];

export default function AdjustmentsPage() {
  const user = useCurrentUser();
  const shop = useShop();
  const lang = getLang();
  const [tab, setTab] = usePersistentState<"quick" | "stocktake">("adjustments:tab", "quick");

  // Deep links like /adjustments?tab=stocktake (dashboard quick actions)
  // preselect the tab once on mount; afterwards the persisted choice wins.
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("tab");
    if (param === "quick" || param === "stocktake") {
      setTab(param);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = useQuery(api.adjustments.stocktakeList, user == null ? "skip" : {});
  const recent = useQuery(api.adjustments.recentChanges, user == null ? "skip" : {});

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={ClipboardCheckIcon} title={t().nav.adjustments} />

      <div className="flex flex-col gap-4 p-4">
        {/* Quick in/out vs full stocktake */}
        <Card>
          <CardContent>
            <Tabs
              value={tab}
              onValueChange={(value) => setTab(value as "quick" | "stocktake")}
              className="w-full"
            >
              <TabsList className="w-full sm:w-auto">
                <TabsTrigger value="quick">{t().adjustments.quickTitle}</TabsTrigger>
                <TabsTrigger value="stocktake">{t().adjustments.stocktakeTitle}</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardContent>
        </Card>

        {tab === "quick" ? (
          <QuickAdjustment items={items ?? []} loading={items === undefined} />
        ) : (
          <StocktakePanel items={items ?? []} loading={items === undefined} />
        )}

        <RecentChanges
          recent={recent ?? []}
          loading={recent === undefined}
          timezone={shop?.timezone ?? "Asia/Phnom_Penh"}
          lang={lang}
        />
      </div>
    </div>
  );
}

// --- Quick manual in/out ----------------------------------------------------

function QuickAdjustment({
  items,
  loading,
}: {
  items: StocktakeVariant[];
  loading: boolean;
}) {
  const [search, setSearch] = useState("");
  const [direction, setDirection] = usePersistentState<"in" | "out">(
    "adjustments:direction",
    "in",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [qtyText, setQtyText] = useState("");
  const [note, setNote] = useState("");
  const adjust = useMutation(api.adjustments.adjustStock);

  const term = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (term ? items.filter((i) => i.label.toLowerCase().includes(term)) : items).slice(0, 60),
    [items, term],
  );
  const selected = items.find((i) => i.variantId === selectedId) ?? null;
  const qty = Number(qtyText);
  const qtyOk = Number.isInteger(qty) && qty >= 1;
  const oversell = direction === "out" && selected !== null && qtyOk && qty > selected.qty;
  const canSave = selected !== null && qtyOk && !oversell && note.trim().length > 0;

  async function submit() {
    if (!selected) {
      toast.error(t().adjustments.pickFirst);
      return;
    }
    try {
      await adjust({
        variantId: selected.variantId,
        delta: direction === "in" ? qty : -qty,
        note: note.trim(),
      });
      toast.success(t().adjustments.adjustmentSaved);
      setSelectedId(null);
      setQtyText("");
      setNote("");
    } catch (err) {
      toastError(err);
    }
  }

  function reset() {
    setSelectedId(null);
    setQtyText("");
    setNote("");
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Item picker */}
      <Card>
        <CardHeader>
          <CardTitle>{t().adjustments.pickItem}</CardTitle>
          <CardDescription>{t().adjustments.selectItemHint}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t().adjustments.searchItems}
          />
          {loading ? (
            <Skeleton className="h-24 w-full" />
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t().adjustments.noItems}</p>
          ) : (
            <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
              {filtered.map((item) => (
                <li key={item.variantId}>
                  <Button
                    type="button"
                    variant={item.variantId === selectedId ? "default" : "outline"}
                    className="flex w-full items-center justify-between gap-2"
                    onClick={() =>
                      setSelectedId(item.variantId === selectedId ? null : item.variantId)
                    }
                  >
                    <span className="truncate">{item.label}</span>
                    <span className="shrink-0 text-xs opacity-80">
                      {t().adjustments.inStock}: {String(item.qty)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* The move itself */}
      <Card>
        <CardHeader>
          <CardTitle>
            {direction === "in" ? t().adjustments.stockIn : t().adjustments.stockOut}
          </CardTitle>
          <CardDescription>
            {selected
              ? `${selected.label} — ${t().adjustments.inStock}: ${String(selected.qty)}`
              : t().adjustments.pickFirst}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant={direction === "in" ? "default" : "outline"}
              onClick={() => setDirection("in")}
            >
              {t().adjustments.stockIn}
            </Button>
            <Button
              type="button"
              variant={direction === "out" ? "default" : "outline"}
              onClick={() => setDirection("out")}
            >
              {t().adjustments.stockOut}
            </Button>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t().adjustments.qty}</span>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              value={qtyText}
              onChange={(e) => setQtyText(e.target.value)}
              className="max-w-40"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">{t().adjustments.reasonNote}</span>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t().adjustments.reasonNoteHint}
              rows={2}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {[
              t().adjustments.reasonDamaged,
              t().adjustments.reasonFound,
              t().adjustments.reasonGiveaway,
            ].map((reason) => (
              <Button
                key={reason}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setNote(reason)}
              >
                {reason}
              </Button>
            ))}
          </div>
          {oversell && (
            <p className="text-sm text-destructive">
              {t().adjustments.notEnough.replace("{n}", String(selected?.qty ?? 0))}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Sticky footer: submit bottom-left + colored cancel with icon */}
      <div className="sticky bottom-3 z-10 flex items-center gap-2 rounded-lg border bg-card p-3 shadow-md">
        <Button onClick={submit} disabled={!canSave}>
          {t().adjustments.saveAdjustment}
        </Button>
        <Button type="button" variant="destructive" onClick={reset}>
          <HugeiconsIcon icon={RotateCwSquareIcon} size={16} />
          {t().common.cancel}
        </Button>
      </div>
    </div>
  );
}

// --- Full stocktake ---------------------------------------------------------

function StocktakePanel({
  items,
  loading,
}: {
  items: StocktakeVariant[];
  loading: boolean;
}) {
  const [search, setSearch] = useState("");
  // Count inputs keyed by variant id — prefilled with the system count, so
  // the owner only types what actually differs on the shelf.
  const [counts, setCounts] = useState<Map<string, string>>(new Map());
  const record = useMutation(api.adjustments.recordStocktake);

  const term = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (term ? items.filter((i) => i.label.toLowerCase().includes(term)) : items).slice(0, 100),
    [items, term],
  );

  const differences = useMemo(
    () =>
      filtered.filter((item) => {
        const text = counts.get(item.variantId);
        if (text === undefined || text === "") return false;
        const n = Number(text);
        return Number.isInteger(n) && n >= 0 && n !== item.qty;
      }),
    [filtered, counts],
  );

  function setCount(id: string, text: string) {
    setCounts((prev) => {
      const next = new Map(prev);
      next.set(id, text);
      return next;
    });
  }

  async function save() {
    const rows = differences.map((item) => ({
      variantId: item.variantId,
      countedQty: Number(counts.get(item.variantId)),
    }));
    if (rows.length === 0) return;
    try {
      const result = await record({ rows });
      toast.success(t().adjustments.stocktakeSaved.replace("{n}", String(result.written)));
      setCounts(new Map());
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t().adjustments.stocktakeTitle}</CardTitle>
          <CardDescription>{t().adjustments.stocktakeHint}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t().adjustments.searchItems}
          />
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t().adjustments.noItems}</p>
          ) : (
            <ul className="flex flex-col">
              {filtered.map((item) => {
                const text = counts.get(item.variantId);
                const n = text === undefined || text === "" ? null : Number(text);
                const differs =
                  n !== null && Number.isInteger(n) && n >= 0 && n !== item.qty;
                return (
                  <li
                    key={item.variantId}
                    className="flex items-center justify-between gap-3 border-b py-2 last:border-b-0"
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{item.label}</span>
                      <span className="text-sm text-muted-foreground">
                        {t().adjustments.inStock}: {String(item.qty)}
                      </span>
                      {differs && n !== null && (
                        <span className="text-xs text-destructive">
                          {n - item.qty > 0 ? `+${n - item.qty}` : String(n - item.qty)}
                        </span>
                      )}
                    </div>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={text ?? String(item.qty)}
                      onChange={(e) => setCount(item.variantId, e.target.value)}
                      aria-label={`${item.label} ${t().adjustments.countedCol}`}
                      className={
                        differs
                          ? "w-20 border-destructive text-right"
                          : "w-20 text-right"
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Sticky footer: submit bottom-left + colored cancel with icon */}
      <div className="sticky bottom-3 z-10 flex items-center gap-2 rounded-lg border bg-card p-3 shadow-md">
        <Button onClick={save} disabled={differences.length === 0}>
          {t().adjustments.saveStocktake}
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => setCounts(new Map())}
          disabled={differences.length === 0}
        >
          <HugeiconsIcon icon={RotateCwSquareIcon} size={16} />
          {t().common.cancel}
        </Button>
        <span className="ml-auto text-sm text-muted-foreground">
          {t().adjustments.changesCount.replace("{n}", String(differences.length))}
        </span>
      </div>
    </div>
  );
}

// --- Recent adjustments (shared, both tabs) ---------------------------------

function RecentChanges({
  recent,
  loading,
  timezone,
  lang,
}: {
  recent: RecentChange[];
  loading: boolean;
  timezone: string;
  lang: Language;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t().adjustments.recentTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-24 w-full" />
        ) : recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t().adjustments.recentEmpty}</p>
        ) : (
          <ul className="flex flex-col">
            {recent.map(({ row, label, userName }) => (
              <li
                key={row._id}
                className="flex items-center justify-between gap-2 border-b py-2 text-sm last:border-b-0"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate font-medium">{label}</span>
                  <span className="truncate text-muted-foreground">
                    {t().stock.reasons[row.reason]}
                    {row.note ? ` · ${row.note}` : ""} ·{" "}
                    {formatDateTime(row.ts, timezone, lang)} · {t().stock.movedBy}{" "}
                    {userName}
                  </span>
                </div>
                <span
                  className={
                    row.delta > 0
                      ? "shrink-0 font-medium"
                      : "shrink-0 font-medium text-destructive"
                  }
                >
                  {row.delta > 0 ? `+${row.delta}` : String(row.delta)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
