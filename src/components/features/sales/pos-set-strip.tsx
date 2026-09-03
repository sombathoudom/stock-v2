"use client";

import { Image01Icon, PackageAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex/react";
import { useState } from "react";

import { api } from "@convex/_generated/api";
import type { CartLine } from "@/hooks/use-checkout-cart";
import { useCurrentUser } from "@/hooks/use-current-user";
import { formatMoney, getLang, imageUrl, t } from "@/lib/utils";

import { PosSetDialog } from "./pos-set-dialog";

// A row of combo-set cards above the product grid on the POS. Tapping a card
// opens the size popup (PosSetDialog); confirming adds the component lines to
// the cart. Hidden entirely when the shop has no active sets, so shops that
// don't sell sets never see it — the single-product grid is untouched.

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
  const sets = useQuery(api.sets.listActive, user == null ? "skip" : {}) ?? [];
  const [active, setActive] = useState<SetDetail | null>(null);

  if (sets.length === 0) return null;

  return (
    <>
      <div className="mb-2 flex flex-col gap-1.5">
        <p className="flex items-center gap-1.5 px-0.5 text-xs font-medium text-muted-foreground">
          <HugeiconsIcon icon={PackageAddIcon} strokeWidth={2} className="size-3.5" />
          {t().nav.sets}
        </p>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {sets.map((detail) => (
            <button
              key={detail.set._id}
              type="button"
              onClick={() => setActive(detail)}
              className="flex w-40 shrink-0 items-center gap-2 rounded-md border p-2 text-left transition-colors hover:border-primary/60"
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
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="line-clamp-1 text-xs font-medium">{detail.set.name}</span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {formatMoney(detail.setTotal, currency, getLang())}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <PosSetDialog
        detail={active}
        currency={currency}
        onClose={() => setActive(null)}
        onAdd={(lines) => onAddLines(lines)}
      />
    </>
  );
}
