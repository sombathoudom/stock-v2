"use client";

import { useState } from "react";

import type { Language } from "@/config/labels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatMoney, t } from "@/lib/utils";

// Sales & Purchases grouped bar chart — hand-rolled SVG (no chart library:
// the bundle stays lean, and the palette rides the CSS variables so both
// themes just work). Sales = var(--chart-1), Purchases = var(--chart-2).
// Day buckets (today/7d/30d/mtd) or month buckets (ytd), always zero-filled
// by the server. Hovering (or tapping on phone) a bar shows a tooltip with
// its date and amount ("Sales: $X" / "Purchases: $X"); the sr-only table
// carries the same numbers for screen readers.

export type DashboardChartBucket = {
  key: string; // YYYY-MM-DD or YYYY-MM
  sales: number;
  purchases: number;
};

type SeriesKey = "sales" | "purchases";

const W = 640;
const H = 260;
const PAD_LEFT = 46;
const PAD_RIGHT = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 30;
const PLOT_W = W - PAD_LEFT - PAD_RIGHT;
const PLOT_H = H - PAD_TOP - PAD_BOTTOM;

/** Round the axis max up to a nice 1/2/5 × 10^k step (4 gridlines). */
function niceMax(max: number): number {
  if (max <= 0) return 1000; // empty range: show a $10 axis
  const rough = max / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / pow;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * pow;
  return step * 4;
}

export function SalesPurchasesChart({
  buckets,
  type,
  currency,
  lang,
}: {
  buckets: DashboardChartBucket[];
  type: "day" | "month";
  currency: string;
  lang: Language;
}) {
  const dash = t().dashboard;
  // Which bar is hovered/tapped — drives the tooltip overlay.
  const [hover, setHover] = useState<{ index: number; series: SeriesKey } | null>(null);
  const moneyFmt = new Intl.NumberFormat(lang === "km" ? "km-KH" : "en-US", {
    style: "currency",
    currency,
    notation: "compact",
    maximumFractionDigits: 1,
  });
  const labelFmt = new Intl.DateTimeFormat(lang === "km" ? "km-KH" : "en-US", {
    timeZone: "UTC",
    month: "short",
    day: type === "day" ? "numeric" : undefined,
  });

  const max = niceMax(
    Math.max(...buckets.map((b) => Math.max(b.sales, b.purchases)), 0)
  );
  const yTicks = [0, 1, 2, 3, 4].map((i) => (max / 4) * i);
  const yOf = (value: number) => PAD_TOP + PLOT_H - (value / max) * PLOT_H;

  // X labels: every bucket when few, otherwise every ~6th plus the last.
  const n = buckets.length;
  const step = n <= 7 ? 1 : Math.ceil(n / 6);
  const labelIndices = new Set<number>();
  for (let i = 0; i < n; i += step) labelIndices.add(i);
  labelIndices.add(n - 1);

  const groupW = PLOT_W / n;
  const barW = Math.min(groupW * 0.32, 14);
  const barGap = 3;

  const bucketLabel = (key: string) => {
    const date = new Date(
      type === "day" ? `${key}T00:00:00Z` : `${key}-01T00:00:00Z`
    );
    return labelFmt.format(date);
  };

  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle className="text-base font-medium">
          {dash.chartSalesPurchases}
        </CardTitle>
        {/* Legend: fixed entity colors — Sales = chart-1, Purchases = chart-2. */}
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-sm"
              style={{ background: "var(--chart-1)" }}
            />
            {dash.kpiSales}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="size-2.5 rounded-sm"
              style={{ background: "var(--chart-2)" }}
            />
            {dash.kpiPurchases}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={dash.chartSalesPurchases}
        >
          {/* Gridlines + compact money ticks. */}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={PAD_LEFT}
                x2={W - PAD_RIGHT}
                y1={yOf(tick)}
                y2={yOf(tick)}
                stroke="var(--border)"
                strokeWidth={1}
              />
              <text
                x={PAD_LEFT - 6}
                y={yOf(tick) + 3}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {moneyFmt.format(tick / 100)}
              </text>
            </g>
          ))}
          {/* Bars: sales then purchases per bucket, centered in the group. */}
          {buckets.map((bucket, i) => {
            const center = PAD_LEFT + i * groupW + groupW / 2;
            const bars: { key: SeriesKey; value: number; color: string; label: string }[] = [
              { key: "sales", value: bucket.sales, color: "var(--chart-1)", label: dash.kpiSales },
              {
                key: "purchases",
                value: bucket.purchases,
                color: "var(--chart-2)",
                label: dash.kpiPurchases,
              },
            ];
            return (
              <g key={bucket.key}>
                {bars.map((bar, bi) => {
                  const x = center + (bi === 0 ? -barW - barGap / 2 : barGap / 2);
                  const y = yOf(bar.value);
                  const barLabel = `${bucketLabel(bucket.key)} — ${bar.label}: ${formatMoney(bar.value, currency, lang)}`;
                  return (
                    <g
                      key={bar.key}
                      role="img"
                      aria-label={barLabel}
                      className="cursor-pointer"
                      onPointerEnter={() => setHover({ index: i, series: bar.key })}
                      onPointerDown={() => setHover({ index: i, series: bar.key })} // phone tap
                      onPointerLeave={() =>
                        setHover((current) =>
                          current && current.index === i && current.series === bar.key
                            ? null
                            : current
                        )
                      }
                    >
                      {/* Full-column invisible hit area so thin bars (30-day
                          view) stay easy to hover; the bar draws on top. */}
                      <rect
                        x={x}
                        y={PAD_TOP}
                        width={barW}
                        height={PLOT_H}
                        fill="transparent"
                      />
                      <rect
                        x={x}
                        y={y}
                        width={barW}
                        height={Math.max(0, PAD_TOP + PLOT_H - y)}
                        fill={bar.color}
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {/* Hover tooltip: the bar's date + "Sales: $X" / "Purchases: $X". */}
          {hover != null &&
            (() => {
              const bucket = buckets[hover.index];
              if (!bucket) return null; // range switched while hovered
              const bar =
                hover.series === "sales"
                  ? { value: bucket.sales, color: "var(--chart-1)", label: dash.kpiSales }
                  : { value: bucket.purchases, color: "var(--chart-2)", label: dash.kpiPurchases };
              const dateText = bucketLabel(bucket.key);
              const amountText = `${bar.label}: ${formatMoney(bar.value, currency, lang)}`;
              // Width from the longer line at the 11px font; Khmer glyphs
              // run wide, so estimate generously and clamp inside the plot.
              const width = Math.max(dateText.length, amountText.length) * 6.8 + 30;
              const height = 46;
              const center = PAD_LEFT + hover.index * groupW + groupW / 2;
              const x = Math.max(PAD_LEFT, Math.min(center - width / 2, W - PAD_RIGHT - width));
              const y = Math.max(PAD_TOP, yOf(bar.value) - height - 8);
              return (
                <g pointerEvents="none">
                  <rect
                    x={x}
                    y={y}
                    width={width}
                    height={height}
                    rx={6}
                    fill="var(--popover)"
                    stroke="var(--border)"
                  />
                  <text
                    x={x + 12}
                    y={y + 20}
                    className="fill-popover-foreground text-[11px] font-medium"
                  >
                    {dateText}
                  </text>
                  <circle cx={x + 13} cy={y + 33} r={4} fill={bar.color} />
                  <text
                    x={x + 23}
                    y={y + 37}
                    className="fill-popover-foreground text-[11px] font-medium"
                  >
                    {amountText}
                  </text>
                </g>
              );
            })()}
          {/* X labels. */}
          {buckets.map((bucket, i) =>
            labelIndices.has(i) ? (
              <text
                key={bucket.key}
                x={PAD_LEFT + i * groupW + groupW / 2}
                y={H - 10}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {bucketLabel(bucket.key)}
              </text>
            ) : null
          )}
        </svg>

        {/* Screen-reader table of the same data. */}
        <table className="sr-only">
          <caption>{dash.chartSalesPurchases}</caption>
          <thead>
            <tr>
              <th scope="col">{dash.kpiSales}</th>
              <th scope="col">{dash.kpiPurchases}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.key}>
                <td>{bucketLabel(bucket.key)}</td>
                <td>{formatMoney(bucket.sales, currency, lang)}</td>
                <td>{formatMoney(bucket.purchases, currency, lang)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
