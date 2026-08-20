"use client";

import type { Id } from "@convex/_generated/dataModel";

import type { Language } from "@/config/labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, t } from "@/lib/utils";

// Top Selling Products — a donut of the top 5 variants by billed pieces
// (rank colors = var(--chart-1..5), the rest = var(--muted)) plus the same
// ranking as progress bars with qty × revenue. All SVG is hand-rolled.

export type TopProduct = {
  variantId: Id<"productVariants">;
  label: string;
  qty: number;
  revenue: number;
};

const C = 2 * Math.PI * 40; // donut circumference (r = 40)

/** Donut arcs in rank order; each slice's offset is the end of the previous. */
function buildSlices(
  topProducts: TopProduct[],
  totalQty: number,
  rankColor: (index: number) => string,
) {
  let offset = 0;
  return topProducts.map((product, i) => {
    const dashLen = (product.qty / totalQty) * C;
    const slice = { product, dashLen, offset, color: rankColor(i) };
    offset += dashLen;
    return slice;
  });
}

export function TopProductsCard({
  topProducts,
  otherQty,
  currency,
  lang,
}: {
  topProducts: TopProduct[];
  otherQty: number;
  currency: string;
  lang: Language;
}) {
  const dash = t().dashboard;
  const totalQty = topProducts.reduce((sum, p) => sum + p.qty, 0) + otherQty;
  const rankColor = (index: number) => `var(--chart-${index + 1})`;

  if (totalQty <= 0) {
    return (
      <Card className="h-full">
        <CardHeader>
          <CardTitle className="text-base font-medium">{dash.topProductsTitle}</CardTitle>
        </CardHeader>
        <CardContent className="flex h-full items-center justify-center pb-8 text-sm text-muted-foreground">
          {dash.topProductsEmpty}
        </CardContent>
      </Card>
    );
  }

  // Donut slices: stroke-dasharray arcs offset in sequence.
  const slices = buildSlices(topProducts, totalQty, rankColor);
  const topDash = slices.length
    ? slices[slices.length - 1].offset + slices[slices.length - 1].dashLen
    : 0;
  const otherSlice = otherQty > 0 ? { dashLen: (otherQty / totalQty) * C, offset: topDash, color: "var(--muted)" } : null;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle className="text-base font-medium">{dash.topProductsTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-center">
          <svg viewBox="0 0 120 120" className="size-36" role="img" aria-label={dash.topProductsTitle}>
            <g transform="rotate(-90 60 60)">
              <circle
                cx={60}
                cy={60}
                r={40}
                fill="none"
                stroke="var(--muted)"
                strokeWidth={20}
                opacity={0.25}
              />
              {slices.map((slice) => (
                <circle
                  key={slice.product.variantId}
                  cx={60}
                  cy={60}
                  r={40}
                  fill="none"
                  stroke={slice.color}
                  strokeWidth={20}
                  strokeDasharray={`${slice.dashLen} ${C - slice.dashLen}`}
                  strokeDashoffset={-slice.offset}
                >
                  <title>
                    {`${slice.product.label}: ${slice.product.qty} — ${formatMoney(slice.product.revenue, currency, lang)}`}
                  </title>
                </circle>
              ))}
              {otherSlice && (
                <circle
                  cx={60}
                  cy={60}
                  r={40}
                  fill="none"
                  stroke={otherSlice.color}
                  strokeWidth={20}
                  strokeDasharray={`${otherSlice.dashLen} ${C - otherSlice.dashLen}`}
                  strokeDashoffset={-otherSlice.offset}
                >
                  <title>{`${dash.other}: ${otherQty}`}</title>
                </circle>
              )}
            </g>
            {/* Center: total pieces sold. */}
            <text
              x={60}
              y={56}
              textAnchor="middle"
              className="fill-foreground font-heading text-lg font-semibold"
            >
              {totalQty}
            </text>
            <text x={60} y={72} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {dash.stockUnits.replace("{n}", "")}
            </text>
          </svg>
        </div>

        {/* Progress-bar ranking: same order and colors as the donut. */}
        <ul className="space-y-2.5">
          {topProducts.map((product, i) => (
            <li key={product.variantId} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ background: rankColor(i) }}
                  />
                  <span className="truncate font-medium">{product.label}</span>
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {product.qty} × {formatMoney(product.revenue, currency, lang)}
                </span>
              </div>
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={product.label}
                aria-valuemin={0}
                aria-valuemax={totalQty}
                aria-valuenow={product.qty}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(product.qty / totalQty) * 100}%`,
                    background: rankColor(i),
                  }}
                />
              </div>
            </li>
          ))}
          {otherQty > 0 && (
            <li className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: "var(--muted)" }} />
                {dash.other}
              </span>
              <span className="tabular-nums">{otherQty}</span>
            </li>
          )}
        </ul>

        {/* Screen-reader table of the same data. */}
        <table className="sr-only">
          <caption>{dash.topProductsTitle}</caption>
          <thead>
            <tr>
              <th scope="col">{dash.topProductsTitle}</th>
              <th scope="col">{dash.stockUnits.replace("{n}", "")}</th>
            </tr>
          </thead>
          <tbody>
            {topProducts.map((product) => (
              <tr key={product.variantId}>
                <td>{product.label}</td>
                <td>{product.qty}</td>
                <td>{formatMoney(product.revenue, currency, lang)}</td>
              </tr>
            ))}
            {otherQty > 0 && (
              <tr>
                <td>{dash.other}</td>
                <td>{otherQty}</td>
                <td>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
