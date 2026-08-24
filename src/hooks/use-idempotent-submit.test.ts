import { describe, expect, test, vi } from "vitest";

import {
  beginIdempotentSubmit,
  canonicalizeSubmitPayload,
  completeIdempotentSubmit,
  type IdempotencyScope,
} from "./use-idempotent-submit";

function memoryStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const scope: IdempotencyScope = {
  userId: "user-1",
  operation: "payments.receive",
  resource: "sale-1",
};

describe("idempotent submit persistence", () => {
  test("canonicalizes sorted object keys while preserving array order", () => {
    expect(
      canonicalizeSubmitPayload({ z: 1, nested: { b: 2, a: 1 }, rows: [2, 1] })
    ).toBe('{"nested":{"a":1,"b":2},"rows":[2,1],"z":1}');
    expect(canonicalizeSubmitPayload({ rows: [1, 2] })).not.toBe(
      canonicalizeSubmitPayload({ rows: [2, 1] })
    );
  });

  test("reuses a key for the same payload across helper instances", () => {
    const storage = memoryStorage();
    const createKey = vi.fn().mockReturnValueOnce("key-1");
    const first = beginIdempotentSubmit(storage, scope, { amount: 500 }, createKey);
    const retry = beginIdempotentSubmit(
      storage,
      scope,
      { amount: 500 },
      createKey
    );

    expect(first).toBe("key-1");
    expect(retry).toBe("key-1");
    expect(createKey).toHaveBeenCalledTimes(1);
  });

  test("changed payload gets a new key and stale completion cannot clear it", () => {
    const storage = memoryStorage();
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce("key-1")
      .mockReturnValueOnce("key-2");
    const firstPayload = { amount: 500 };
    const secondPayload = { amount: 600 };
    const first = beginIdempotentSubmit(storage, scope, firstPayload, createKey);
    const second = beginIdempotentSubmit(storage, scope, secondPayload, createKey);

    completeIdempotentSubmit(storage, scope, firstPayload, first);
    expect(beginIdempotentSubmit(storage, scope, secondPayload, createKey)).toBe(second);
    completeIdempotentSubmit(storage, scope, secondPayload, second);
    createKey.mockReturnValueOnce("key-3");
    expect(beginIdempotentSubmit(storage, scope, secondPayload, createKey)).toBe("key-3");
  });

  test("scopes records by authenticated user, operation, and resource", () => {
    const storage = memoryStorage();
    const createKey = vi
      .fn<() => string>()
      .mockReturnValueOnce("key-1")
      .mockReturnValueOnce("key-2");

    const first = beginIdempotentSubmit(storage, scope, { amount: 500 }, createKey);
    const second = beginIdempotentSubmit(
      storage,
      { ...scope, userId: "user-2" },
      { amount: 500 },
      createKey
    );

    expect(first).toBe("key-1");
    expect(second).toBe("key-2");
  });
});
