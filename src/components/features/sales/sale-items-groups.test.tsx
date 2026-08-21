// @vitest-environment happy-dom
// Component test for the expanded Sale Detail line table (sale-items-groups):
// every line body cell must sit under the correct header, on BOTH the desktop
// table and the mobile/card layout. The rest of the suite runs in the
// edge-runtime environment; this file opts into a DOM via the pragma above.
// No database is involved — the fixture lines mirror the server's
// `saleItemDetail` shape (convex/types.ts) one-for-one.

import { cleanup, fireEvent, render, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { SaleItemGroups } from "./sale-items-groups";

type SaleDetailItem = ComponentProps<typeof SaleItemGroups>["items"][number];

/** The exact final column order of the expanded per-line table. */
const HEADERS = [
  "Sale line / SKU",
  "Ordered",
  "Delivered",
  "Cancelled",
  "Returned",
  "Customer has",
  "Price",
  "Discount",
  "Total",
  "Actions",
];

afterEach(cleanup);

/** A minimal but complete detail line. `withCustomer` mirrors the server
 * derivation: qtyDelivered − qtyReturned. */
function detailItem(args: {
  sku: string;
  size: string;
  unitPrice: number;
  qtyOrdered: number;
  qtyDelivered: number;
  qtyCancelled: number;
  qtyReturned: number;
}): SaleDetailItem {
  return {
    item: {
      _id: `si-${args.sku}-${args.qtyOrdered}`,
      _creationTime: 1,
      saleId: "sale-1",
      variantId: `v-${args.size}`,
      unitPrice: args.unitPrice,
      unitCostSnapshot: 300,
      qtyOrdered: args.qtyOrdered,
      qtyDelivered: args.qtyDelivered,
      qtyCancelled: args.qtyCancelled,
      qtyReturned: args.qtyReturned,
    },
    variant: {
      _id: `v-${args.size}`,
      _creationTime: 1,
      productId: "p-1",
      size: args.size,
      sku: args.sku,
      active: true,
    },
    product: {
      _id: "p-1",
      _creationTime: 1,
      name: "Shirt 001",
      nameLower: "shirt 001",
      defaultPrice: 600,
      defaultCost: 300,
      hasColors: false,
      sizes: ["M", "L", "XL", "2XL", "3XL"],
      colors: [],
      active: true,
    },
    withCustomer: args.qtyDelivered - args.qtyReturned,
  } as unknown as SaleDetailItem;
}

/** The three fixture lines:
 * 1. the exact row the user quoted — 2XL, fully returned (bills $0.00);
 * 2. a 2XL still with the customer (bills $6.00);
 * 3. an M proving the derivation customerHas = qtyDelivered − qtyReturned:
 *    2 delivered, 1 returned → Customer has 1, bills 1 piece at $5.00. */
function fixtureItems(): SaleDetailItem[] {
  return [
    detailItem({
      sku: "SH001-2XL",
      size: "2XL",
      unitPrice: 600,
      qtyOrdered: 1,
      qtyDelivered: 1,
      qtyCancelled: 0,
      qtyReturned: 1,
    }),
    detailItem({
      sku: "SH001-2XL",
      size: "2XL",
      unitPrice: 600,
      qtyOrdered: 1,
      qtyDelivered: 1,
      qtyCancelled: 0,
      qtyReturned: 0,
    }),
    detailItem({
      sku: "SH001-M",
      size: "M",
      unitPrice: 500,
      qtyOrdered: 2,
      qtyDelivered: 2,
      qtyCancelled: 0,
      qtyReturned: 1,
    }),
  ];
}

function renderGroups(items: SaleDetailItem[]) {
  return render(
    <SaleItemGroups
      items={items}
      currency="USD"
      adjustable
      onAdjust={() => {}}
      onReturn={() => {}}
    />
  );
}

/** Desktop table shell: `hidden md:block`. */
function desktopOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[class~="md:block"]')!;
}

/** Mobile card shell: `md:hidden`. CSS media queries never evaluate in the
 * DOM test environment, so both layouts sit in the tree — which is exactly
 * what lets the test assert both without switching viewports. */
function mobileOf(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('[class~="md:hidden"]')!;
}

/** Expand one group by its variant label ("2XL", "M") — the expand button's
 * aria-label is "Show details — <product> <variant>". */
function expandGroup(scope: HTMLElement, variantLabel: string): void {
  fireEvent.click(
    within(scope).getByRole("button", {
      name: new RegExp(variantLabel, "i"),
    })
  );
}

/** Every expanded group's per-line nested table (each starts with the
 * "Sale line / SKU" header). */
function lineTables(desktop: HTMLElement): HTMLTableElement[] {
  const headers = within(desktop).getAllByRole("columnheader", {
    name: "Sale line / SKU",
  });
  return [...new Set(headers.map((h) => h.closest("table")!))];
}

describe("SaleItemGroups expanded line table", () => {
  it("desktop: every line cell renders under the correct header", () => {
    const { container } = renderGroups(fixtureItems());
    const desktop = desktopOf(container);
    expandGroup(desktop, "2XL");
    expandGroup(desktop, "M");

    const tables = lineTables(desktop);
    expect(tables).toHaveLength(2); // one per expanded group

    const rowsInOrder: HTMLElement[] = [];
    for (const table of tables) {
      const headers = within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent!.trim());
      expect(headers).toEqual(HEADERS);
      // No column header may still carry the old wording.
      for (const header of headers) {
        expect(header).not.toMatch(/with customer/i);
      }
      rowsInOrder.push(...within(table).getAllByRole("row").slice(1));
    }

    const expectedCells: string[][] = [
      ["SH001-2XL", "1", "1", "0", "1", "0", "$6.00", "—", "$0.00"],
      ["SH001-2XL", "1", "1", "0", "0", "1", "$6.00", "—", "$6.00"],
      ["SH001-M", "2", "2", "0", "1", "1", "$5.00", "—", "$5.00"],
    ];
    expect(rowsInOrder).toHaveLength(expectedCells.length);
    rowsInOrder.forEach((row, r) => {
      const cells = within(row).getAllByRole("cell");
      expect(cells).toHaveLength(HEADERS.length);
      expectedCells[r].forEach((text, c) => {
        expect(cells[c].textContent).toContain(text);
      });
    });
  });

  it("desktop: returned lines show the sellable state and mute their zeros", () => {
    const { container } = renderGroups(fixtureItems());
    const desktop = desktopOf(container);
    expandGroup(desktop, "2XL");

    const table = lineTables(desktop)[0];
    const rows = within(table).getAllByRole("row").slice(1);

    // Row 0 — fully returned: Cancelled 0, Customer has 0, Total $0.00.
    const returnedCells = within(rows[0]).getAllByRole("cell");
    expect(within(returnedCells[0]).getByText("Returned · Sellable")).toBeTruthy();
    expect(returnedCells[3].className).toContain("text-muted-foreground"); // Cancelled 0
    expect(returnedCells[5].className).toContain("text-muted-foreground"); // Customer has 0
    expect(returnedCells[8].className).toContain("text-muted-foreground"); // Total $0.00
    expect(returnedCells[2].className).not.toContain("text-muted-foreground"); // Delivered 1

    // Row 1 — still with the customer: no badge, Customer has 1 not muted.
    const heldCells = within(rows[1]).getAllByRole("cell");
    expect(within(heldCells[0]).queryByText("Returned · Sellable")).toBeNull();
    expect(heldCells[5].className).not.toContain("text-muted-foreground");
  });

  it("mobile cards: same values under plain-language labels, zeros muted, state shown", () => {
    const { container } = renderGroups(fixtureItems());
    const mobile = mobileOf(container);
    expandGroup(mobile, "2XL");
    expandGroup(mobile, "M");

    const cards = mobile.querySelectorAll<HTMLElement>('[class*="divide-y"] > div');
    expect(cards).toHaveLength(3);

    const expectCard = (
      card: HTMLElement,
      pairs: [string, string][],
      state: string | null,
      subtotal: string
    ) => {
      const text = card.textContent!.replace(/\s+/g, " ");
      for (const [label, value] of pairs) {
        expect(text).toContain(`${label}: ${value}`);
      }
      if (state) {
        expect(within(card).getByText(state)).toBeTruthy();
      } else {
        expect(within(card).queryByText("Returned · Sellable")).toBeNull();
      }
      expect(text).toContain(subtotal);
    };

    expectCard(
      cards[0],
      [
        ["Ordered", "1"],
        ["Delivered", "1"],
        ["Cancelled", "0"],
        ["Returned", "1"],
        ["Customer has", "0"],
        ["Price", "$6.00"],
      ],
      "Returned · Sellable",
      "$0.00"
    );
    expectCard(
      cards[1],
      [
        ["Ordered", "1"],
        ["Delivered", "1"],
        ["Cancelled", "0"],
        ["Returned", "0"],
        ["Customer has", "1"],
        ["Price", "$6.00"],
      ],
      null,
      "$6.00"
    );
    expectCard(
      cards[2],
      [
        ["Ordered", "2"],
        ["Delivered", "2"],
        ["Cancelled", "0"],
        ["Returned", "1"],
        ["Customer has", "1"],
        ["Price", "$5.00"],
      ],
      "Returned · Sellable",
      "$5.00"
    );
  });
});
