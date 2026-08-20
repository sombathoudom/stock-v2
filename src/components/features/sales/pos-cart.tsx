"use client";

import { Delete02Icon, Image01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cartLineId, type CartLine } from "@/hooks/use-checkout-cart";
import { formatMoney, getLang, imageUrl, inputToCents, t } from "@/lib/utils";

// T10 — POS cart (AGENTS.md, checkout step ①). Display-only totals: the
// checkout mutation re-derives every price, discount and total server-side.
// `bare` renders the same lines list without the Card shell, for embedding
// inside the phone's bottom Sheet (which has its own header/footer chrome).

export function PosCart({
  lines,
  currency,
  onUpdate,
  onRemove,
  bare = false,
}: {
  lines: CartLine[];
  currency: string;
  /** Patch one line (qty, discount) by its line key. */
  onUpdate: (lineKey: string, patch: Partial<CartLine>) => void;
  onRemove: (lineKey: string) => void;
  /** Render without the Card shell (inside the phone cart Sheet). */
  bare?: boolean;
}) {
  const totals = lines.map((line) => {
    const discountCents = inputToCents(line.discount) ?? 0;
    const lineTotal = line.price * line.qty - discountCents;
    return { line, discountCents, lineTotal };
  });
  const totalQty = totals.reduce((sum, t) => sum + t.line.qty, 0);

  const body = (
    <>
      {lines.length === 0 && (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {t().sales.cartEmpty}
        </p>
      )}
      {totals.map(({ line, lineTotal }) => (
        <div key={cartLineId(line)} className="flex items-start gap-2 border-b pb-2 last:border-b-0">
          {/* Small product thumbnail; a consistent placeholder when the
              product has no photo. */}
          {line.imageStorageId ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl(line.imageStorageId)}
              alt=""
              className="size-9 shrink-0 rounded border object-cover"
            />
          ) : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded border bg-muted text-muted-foreground">
              <HugeiconsIcon icon={Image01Icon} strokeWidth={2} className="size-4" />
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 flex-1 truncate text-sm font-medium">
                {line.label}
              </p>
              <p className="shrink-0 text-sm font-semibold tabular-nums">
                {formatMoney(lineTotal, currency, getLang())}
              </p>
            </div>
            <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7"
                disabled={line.qty <= 1}
                onClick={() => onUpdate(cartLineId(line), { qty: line.qty - 1 })}
                aria-label="-"
              >
                −
              </Button>
              <span className="w-6 text-center text-sm tabular-nums">
                {line.qty}
              </span>
              {/* The + stepper clamps to the stock snapshot taken when the
                  card was tapped. Display-only — checkout re-checks the
                  ledger server-side. Legacy lines without a snapshot stay
                  unclamped. */}
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7"
                disabled={line.qty >= (line.stock ?? Number.POSITIVE_INFINITY)}
                onClick={() => onUpdate(cartLineId(line), { qty: line.qty + 1 })}
                aria-label="+"
              >
                +
              </Button>
              <span className="pl-1 text-xs text-muted-foreground">
                × {formatMoney(line.price, currency, getLang())}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Input
                inputMode="decimal"
                className="h-8 w-16"
                placeholder="0.00"
                aria-label={t().sales.itemDiscount}
                value={line.discount}
                onChange={(e) =>
                  onUpdate(cartLineId(line), { discount: e.target.value })
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-destructive"
                onClick={() => onRemove(cartLineId(line))}
                aria-label={t().sales.remove}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} className="size-4" />
              </Button>
            </div>
            </div>
          </div>
        </div>
      ))}
    </>
  );

  if (bare) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-base font-semibold">{t().sales.cart}</span>
          {totalQty > 0 ? (
            <span className="text-sm font-normal text-muted-foreground">
              · {totalQty} {t().sales.itemsCount}
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-2">{body}</div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {t().sales.cart}
          {totalQty > 0 ? (
            <span className="text-sm font-normal text-muted-foreground">
              {" "}
              · {totalQty} {t().sales.itemsCount}
            </span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">{body}</CardContent>
    </Card>
  );
}
