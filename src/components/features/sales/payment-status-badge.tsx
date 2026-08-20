"use client";

import type { Doc } from "@convex/_generated/dataModel";

import { Badge } from "@/components/ui/badge";
import { t } from "@/lib/utils";

// Paid / Partly paid / Unpaid badge for the sales list — derived from the
// row's paid + remaining (both computed server-side, no extra fetch).
// A cancelled order shows a dash — its money state is frozen — UNLESS it was
// cancelled with the delivery trip still billed, in which case that shipping
// fee is a live debt and gets the normal paid/unpaid badge.
// Colors: green = paid, red = unpaid, blue = partly paid.

export function PaymentStatusBadge({
  status,
  paid,
  remaining,
}: {
  status: Doc<"sales">["status"];
  paid: number;
  remaining: number;
}) {
  if (status === "cancelled" && paid <= 0 && remaining <= 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (remaining <= 0) {
    return <Badge variant="success">{t().sales.paymentStatuses.paid}</Badge>;
  }
  if (paid <= 0) {
    return <Badge variant="destructive">{t().sales.paymentStatuses.unpaid}</Badge>;
  }
  return <Badge variant="info">{t().sales.paymentStatuses.partlyPaid}</Badge>;
}
