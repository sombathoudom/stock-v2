import { describe, expect, test } from "vitest";

import {
  addCartLine,
  type CartLine,
} from "./use-checkout-cart";

const variant = (
  variantId: string,
  stock: number,
  discount = ""
): Omit<CartLine, "key"> => ({
  variantId,
  label: variantId,
  price: 500,
  qty: 1,
  discount,
  stock,
});

describe("addCartLine", () => {
  test("increments quantity when the same variant is added again", () => {
    const first = addCartLine([], variant("v-shirt", 2), "line-1");
    const second = addCartLine(first, variant("v-shirt", 2), "line-2");

    expect(second).toHaveLength(1);
    expect(second[0]).toEqual(expect.objectContaining({ key: "line-1", qty: 2 }));
  });

  test("caps aggregate quantity for the same variant at its stock snapshot", () => {
    const first = addCartLine([], variant("v-shirt", 2), "line-1");
    const second = addCartLine(first, variant("v-shirt", 2), "line-2");
    const overStock = addCartLine(second, variant("v-shirt", 2), "line-3");

    expect(overStock).toBe(second);
    expect(overStock[0].qty).toBe(2);
  });

  test("preserves the existing discount when increasing quantity", () => {
    const discounted = addCartLine(
      [],
      variant("v-shirt", 2, "1.00"),
      "discounted"
    );
    const added = addCartLine(discounted, variant("v-shirt", 2), "regular");
    const overStock = addCartLine(added, variant("v-shirt", 2), "extra");

    expect(added).toHaveLength(1);
    expect(added[0]).toEqual(
      expect.objectContaining({ qty: 2, discount: "1.00" })
    );
    expect(overStock).toBe(added);
  });

  test("tracks stock independently for different variants", () => {
    const shirt = addCartLine([], variant("v-shirt", 1), "shirt");
    const trousers = addCartLine(shirt, variant("v-trousers", 1), "trousers");

    expect(trousers.map((line) => line.variantId)).toEqual([
      "v-shirt",
      "v-trousers",
    ]);
  });

  test("does not add an out-of-stock variant", () => {
    const current = addCartLine([], variant("v-shirt", 1), "shirt");
    const result = addCartLine(current, variant("v-socks", 0), "socks");

    expect(result).toBe(current);
  });

  test("does not mutate the input cart or its lines", () => {
    const existing: CartLine = {
      ...variant("v-shirt", 2),
      key: "existing",
    };
    const current = [existing];
    const snapshot = structuredClone(current);

    const result = addCartLine(current, variant("v-shirt", 2), "new");

    expect(current).toEqual(snapshot);
    expect(current[0]).toBe(existing);
    expect(result).not.toBe(current);
    expect(result[0]).not.toBe(existing);
    expect(result[0].qty).toBe(2);
  });
});
