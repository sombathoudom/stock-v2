// Pure UI projection for the Sale Detail payment history. ALL numbers are
// derived from the existing server payment rows — nothing is cached, nothing
// is written:
//   grossReceived  = sum(positive payments)
//   totalRefunded  = absolute sum(negative refund payments)
//   netPaid        = grossReceived − totalRefunded
//   remaining      = max(orderTotal − netPaid, 0)
//   overpaid       = max(netPaid − orderTotal, 0)
// "Net paid" means received minus refunds — never labeled just "Paid".

export type PaymentRowSource = {
  _id: string;
  amount: number; // cents, negative = refund
  receivedAt: number; // epoch ms
  method: "cash" | "bank_transfer" | "other" | "refund";
  note?: string;
  userId: string;
};

export type PaymentStatus =
  | "unpaid"
  | "fully_refunded"
  | "partially_paid"
  | "paid"
  | "overpaid";

export type PaymentSummary = {
  grossReceived: number;
  totalRefunded: number;
  netPaid: number;
  remaining: number;
  overpaid: number;
  /** What a refund may currently reach — the net-paid balance. */
  refundable: number;
  status: PaymentStatus;
  hasRefunds: boolean;
};

export function summarizePayments(
  orderTotal: number,
  payments: PaymentRowSource[]
): PaymentSummary {
  let grossReceived = 0;
  let totalRefunded = 0;
  for (const p of payments) {
    if (p.amount > 0) grossReceived += p.amount;
    else totalRefunded += -p.amount;
  }
  const netPaid = grossReceived - totalRefunded;
  const remaining = Math.max(orderTotal - netPaid, 0);
  const overpaid = Math.max(netPaid - orderTotal, 0);
  let status: PaymentStatus;
  if (netPaid <= 0) {
    status = payments.length === 0 ? "unpaid" : "fully_refunded";
  } else if (netPaid >= orderTotal) {
    status = netPaid > orderTotal ? "overpaid" : "paid";
  } else {
    status = "partially_paid";
  }
  return {
    grossReceived,
    totalRefunded,
    netPaid,
    remaining,
    overpaid,
    refundable: Math.max(netPaid, 0),
    status,
    hasRefunds: totalRefunded > 0,
  };
}

/** Newest transaction first — the existing product convention. */
export function paymentsNewestFirst(
  payments: PaymentRowSource[]
): PaymentRowSource[] {
  return [...payments].sort((a, b) => b.receivedAt - a.receivedAt);
}
