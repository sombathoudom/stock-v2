"use client";

import type { Doc } from "@convex/_generated/dataModel";

import { Badge } from "@/components/ui/badge";
import { t } from "@/lib/utils";

// T12 — order status badge, shared by the sales list and the order detail
// page. Labels come from the shared t().status block (plain-language words,
// Khmer/English via the labels module). Each status gets a distinct color
// (semantic tokens from globals.css): gray = draft, blue = confirmed,
// amber = pending/packed/partially delivered, violet = delivering,
// green = delivered, red = cancelled.

const VARIANTS: Record<
  Doc<"sales">["status"],
  "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info" | "violet"
> = {
  draft: "secondary",
  confirmed: "info",
  pending: "warning",
  packed: "warning",
  delivering: "violet",
  delivered: "success",
  partially_delivered: "warning",
  cancelled: "destructive",
};

export function SaleStatusBadge({ status }: { status: Doc<"sales">["status"] }) {
  return <Badge variant={VARIANTS[status]}>{t().status[status]}</Badge>;
}
