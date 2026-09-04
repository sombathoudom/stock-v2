"use client";

import {
  Image01Icon,
  PackageAddIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex/react";
import { useMemo, useState } from "react";

import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import type { CartLine } from "@/hooks/use-checkout-cart";
import { useCurrentUser } from "@/hooks/use-current-user";
import { formatMoney, getLang, imageUrl, t } from "@/lib/utils";

import { PosSetDialog } from "./pos-set-dialog";

// Combo sets on the POS: ONE "Sets" button. Tapping it opens a picker dialog
// that lists every active set with a search filter; picking a set opens the
// size popup (PosSetDialog), which adds the component lines to the cart. The
// button (and everything below it) is hidden when the shop has no sets, so
// the single-product grid is untouched for shops that don't sell sets.

type SetDetail = FunctionReturnType<typeof api.sets.listActive>[number];

export function PosSetStrip({
  currency,
  onAddLines,
}: {
  currency: string;
  /** Append the resolved set component lines to the cart. */
  onAddLines: (lines: Omit<CartLine, "key">[]) => void;
}) {
  const user = useCurrentUser();
  const setsResult = useQuery(api.sets.listActive, user == null ? "skip" : {});
  const sets = useMemo(() => setsResult ?? [], [setsResult]);

  // Which stage is open: null = closed; "pick" = the set list; a set = its
  // size popup.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [active, setActive] = useState<SetDetail | null>(null);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sets;
    return sets.filter((s) => s.set.name.toLowerCase().includes(q));
  }, [sets, query]);

  if (sets.length === 0) return null;

  function openSet(detail: SetDetail) {
    setPickerOpen(false);
    setActive(detail);
  }

  return (
    <>
      {/* The one entry point. */}
      <Button
        type="button"
        variant="outline"
        className="mb-2 w-full justify-start"
        onClick={() => {
          setQuery("");
          setPickerOpen(true);
        }}
      >
        <HugeiconsIcon icon={PackageAddIcon} strokeWidth={2} className="size-4" />
        {t().sets.sellSet}
      </Button>

      {/* Set picker: a searchable list of all active sets. */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        {/* Fixed-height flex column: header + search stay pinned, only the
            list scrolls — so a long catalog (50+ sets) never grows the dialog
            off-screen. */}
        <DialogContent className="flex h-[80vh] max-h-[80vh] flex-col gap-3 overflow-hidden sm:max-w-md">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t().sets.sellSet}</DialogTitle>
            <DialogDescription>{t().sets.pickSetHint}</DialogDescription>
          </DialogHeader>

          <InputGroup className="shrink-0">
            <InputGroupAddon>
              <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-4" />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t().sets.searchPlaceholder}
              aria-label={t().sets.searchPlaceholder}
              autoFocus
            />
          </InputGroup>

          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto overscroll-contain px-1">
            {filtered.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t().common.noResults}
              </p>
            ) : (
              filtered.map((detail) => (
                <button
                  key={detail.set._id}
                  type="button"
                  onClick={() => openSet(detail)}
                  className="flex items-center gap-2.5 rounded-md border p-2 text-left transition-colors hover:border-primary/60"
                >
                  {detail.set.imageStorageId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={imageUrl(detail.set.imageStorageId)}
                      alt=""
                      className="size-9 shrink-0 rounded border object-cover"
                    />
                  ) : (
                    <span className="flex size-9 shrink-0 items-center justify-center rounded border bg-muted text-muted-foreground">
                      <HugeiconsIcon icon={Image01Icon} strokeWidth={2} className="size-4" />
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="line-clamp-1 text-sm font-medium">
                      {detail.set.name}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {detail.items.length} {t().sets.components.toLowerCase()}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums">
                    {formatMoney(detail.setTotal, currency, getLang())}
                  </span>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Size popup for the chosen set. */}
      <PosSetDialog
        detail={active}
        currency={currency}
        onClose={() => setActive(null)}
        onAdd={(lines) => onAddLines(lines)}
      />
    </>
  );
}
