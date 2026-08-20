"use client";

import { Button } from "@/components/ui/button";
import { t } from "@/lib/utils";

// The dashboard's range filter — Today / 7D / 30D / MTD / YTD. The chosen
// value is persisted by the page via usePersistentState, so it survives
// reloads; the labels come from the shared labels module (Khmer/English).

export type DashboardRange = "today" | "7d" | "30d" | "mtd" | "ytd";

export function DashboardRangeChips({
  value,
  onChange,
}: {
  value: DashboardRange;
  onChange: (range: DashboardRange) => void;
}) {
  const dash = t().dashboard;
  const options: { value: DashboardRange; label: string }[] = [
    { value: "today", label: dash.todayTitle },
    { value: "7d", label: dash.range7d },
    { value: "30d", label: dash.range30d },
    { value: "mtd", label: dash.rangeMtd },
    { value: "ytd", label: dash.rangeYtd },
  ];
  return (
    <div className="flex flex-wrap items-center gap-1">
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant={option.value === value ? "default" : "outline"}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
