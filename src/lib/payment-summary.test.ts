import { describe, expect, test } from "vitest";

import {
  paymentsNewestFirst,
  summarizePayments,
  type PaymentRowSource,
} from "./payment-summary";

// Projection tests for the payment-history summary. For every scenario the
// spec's numbers are verified: gross received / total refunded / net paid /
// remaining / overpaid (refund due) / transaction sign and label.

const ORDER_TOTAL = 2500; // $25.00
const cash = (amount: number, receivedAt = 1): PaymentRowSource => ({
  _id: `p-${amount}-${receivedAt}`,
  amount,
  receivedAt,
  method: "cash",
  userId: "u1",
});
const refund = (amount: number, receivedAt = 2): PaymentRowSource => ({
  _id: `r-${amount}-${receivedAt}`,
  amount: -amount,
  receivedAt,
  method: "refund",
  userId: "u1",
});

describe("summarizePayments", () => {
  test("1. unpaid order", () => {
    const s = summarizePayments(ORDER_TOTAL, []);
    expect(s.grossReceived).toBe(0);
    expect(s.totalRefunded).toBe(0);
    expect(s.netPaid).toBe(0);
    expect(s.remaining).toBe(2500);
    expect(s.overpaid).toBe(0);
    expect(s.status).toBe("unpaid");
    expect(s.refundable).toBe(0);
  });

  test("2. partially paid order", () => {
    const s = summarizePayments(ORDER_TOTAL, [cash(1200)]);
    expect(s.grossReceived).toBe(1200);
    expect(s.totalRefunded).toBe(0);
    expect(s.netPaid).toBe(1200);
    expect(s.remaining).toBe(1300);
    expect(s.overpaid).toBe(0);
    expect(s.status).toBe("partially_paid");
  });

  test("3. fully paid order", () => {
    const s = summarizePayments(ORDER_TOTAL, [cash(2500)]);
    expect(s.netPaid).toBe(2500);
    expect(s.remaining).toBe(0);
    expect(s.overpaid).toBe(0);
    expect(s.status).toBe("paid");
  });

  test("4. positive payment followed by a partial refund", () => {
    const s = summarizePayments(ORDER_TOTAL, [cash(2000), refund(500)]);
    expect(s.grossReceived).toBe(2000);
    expect(s.totalRefunded).toBe(500);
    expect(s.netPaid).toBe(1500); // received − refunded, never "paid" alone
    expect(s.remaining).toBe(1000);
    expect(s.overpaid).toBe(0);
    expect(s.status).toBe("partially_paid");
    expect(s.hasRefunds).toBe(true);
  });

  test("5. fully refunded payment", () => {
    const s = summarizePayments(ORDER_TOTAL, [cash(2500), refund(2500)]);
    expect(s.grossReceived).toBe(2500);
    expect(s.totalRefunded).toBe(2500);
    expect(s.netPaid).toBe(0);
    expect(s.remaining).toBe(2500);
    expect(s.overpaid).toBe(0);
    expect(s.status).toBe("fully_refunded");
    expect(s.refundable).toBe(0); // refund button disabled
  });

  test("6. overpaid order / refund due", () => {
    const s = summarizePayments(ORDER_TOTAL, [cash(3000)]);
    expect(s.grossReceived).toBe(3000);
    expect(s.netPaid).toBe(3000);
    expect(s.remaining).toBe(0);
    expect(s.overpaid).toBe(500);
    expect(s.status).toBe("overpaid");
  });

  test("7. multiple payment methods all count into gross", () => {
    const s = summarizePayments(ORDER_TOTAL, [
      cash(800),
      { ...cash(0), amount: 400, method: "bank_transfer" },
      { ...cash(0), amount: 300, method: "other" },
    ]);
    expect(s.grossReceived).toBe(1500);
    expect(s.netPaid).toBe(1500);
    expect(s.remaining).toBe(1000);
    expect(s.status).toBe("partially_paid");
  });

  test("8. backdated payment counts like any other", () => {
    const s = summarizePayments(ORDER_TOTAL, [cash(2500, 123456789)]);
    expect(s.netPaid).toBe(2500);
    expect(s.remaining).toBe(0);
    expect(s.status).toBe("paid");
  });

  test("9. transaction with note and user keeps both", () => {
    const p = { ...cash(1200), note: "Dara paid by phone", userId: "u-owner" };
    const s = summarizePayments(ORDER_TOTAL, [p]);
    expect(s.netPaid).toBe(1200);
    expect(s.status).toBe("partially_paid");
    // the row projection keeps note/user (asserted via the source row)
    expect(p.note).toBe("Dara paid by phone");
    expect(p.userId).toBe("u-owner");
  });

  test("10. empty payment history", () => {
    const s = summarizePayments(ORDER_TOTAL, []);
    expect(s.grossReceived).toBe(0);
    expect(s.totalRefunded).toBe(0);
    expect(s.netPaid).toBe(0);
    expect(s.remaining).toBe(2500);
    expect(s.overpaid).toBe(0);
    expect(s.status).toBe("unpaid");
  });

  test("11. refundable (net paid) is zero after full refund — button disabled", () => {
    const s = summarizePayments(ORDER_TOTAL, [cash(1000), refund(1000)]);
    expect(s.refundable).toBe(0);
    expect(s.totalRefunded).toBe(1000);
    expect(s.netPaid).toBe(0);
    expect(s.remaining).toBe(2500);
  });

  test("12. gross never mislabeled: refunds reduce net paid, not gross", () => {
    const s = summarizePayments(ORDER_TOTAL, [cash(2000), cash(500), refund(1000)]);
    expect(s.grossReceived).toBe(2500);
    expect(s.totalRefunded).toBe(1000);
    expect(s.netPaid).toBe(1500);
    expect(s.remaining).toBe(1000);
    expect(s.overpaid).toBe(0);
  });
});

describe("paymentsNewestFirst", () => {
  test("newest transaction first, stable for ties", () => {
    const rows = [cash(100, 1), cash(300, 3), cash(200, 2)];
    const sorted = paymentsNewestFirst(rows);
    expect(sorted.map((r) => r.amount)).toEqual([300, 200, 100]);
  });
});
