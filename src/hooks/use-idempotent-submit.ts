"use client";

import { useCallback, useRef } from "react";

import { useCurrentUser } from "@/hooks/use-current-user";

const RECORD_VERSION = 1;
const STORAGE_PREFIX = "idempotent-submit:v1";

type StorageRecord = {
  version: number;
  key: string;
  fingerprint: string;
};

export type IdempotencyScope = {
  userId: string;
  operation: string;
  resource: string;
};

type SubmitStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(fallback: Map<string, string>): SubmitStorage {
  return {
    getItem(key) {
      try {
        return window.localStorage.getItem(key) ?? fallback.get(key) ?? null;
      } catch {
        return fallback.get(key) ?? null;
      }
    },
    setItem(key, value) {
      fallback.set(key, value);
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // The in-memory record still protects retries while this UI is mounted.
      }
    },
    removeItem(key) {
      fallback.delete(key);
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Nothing else to clear when browser storage is unavailable.
      }
    },
  };
}

function canonicalize(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Submit payload contains an invalid number.");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new Error("Submit payload contains an unsupported value.");
  }
  if (seen.has(value)) throw new Error("Submit payload must not contain cycles.");

  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    result = `[${value
      .map((item) => (item === undefined ? "null" : canonicalize(item, seen)))
      .join(",")}]`;
  } else {
    const entries = Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalize(
            (value as Record<string, unknown>)[key],
            seen
          )}`
      );
    result = `{${entries.join(",")}}`;
  }
  seen.delete(value);
  return result;
}

/** Stable JSON-like representation: object keys sort, array order is retained. */
export function canonicalizeSubmitPayload(payload: unknown): string {
  return canonicalize(payload, new WeakSet());
}

/** Compact synchronous fingerprint; the canonical business payload is never persisted. */
export function fingerprintSubmitPayload(payload: unknown): string {
  const canonical = canonicalizeSubmitPayload(payload);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${canonical.length.toString(36)}-${(first >>> 0).toString(36)}-${(
    second >>> 0
  ).toString(36)}`;
}

function storageKey(scope: IdempotencyScope): string {
  return [
    STORAGE_PREFIX,
    scope.userId,
    scope.operation,
    scope.resource,
  ]
    .map(encodeURIComponent)
    .join(":");
}

function readRecord(storage: SubmitStorage, key: string): StorageRecord | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    throw new Error("Unable to read pending submit data.", { cause: error });
  }
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      (value as Partial<StorageRecord>).version === RECORD_VERSION &&
      typeof (value as Partial<StorageRecord>).key === "string" &&
      typeof (value as Partial<StorageRecord>).fingerprint === "string"
    ) {
      return value as StorageRecord;
    }
  } catch {
    // A malformed or old record is replaced by the next submit.
  }
  return null;
}

export function beginIdempotentSubmit(
  storage: SubmitStorage,
  scope: IdempotencyScope,
  payload: unknown,
  createKey: () => string
): string {
  const key = storageKey(scope);
  const fingerprint = fingerprintSubmitPayload(payload);
  const existing = readRecord(storage, key);
  if (existing?.fingerprint === fingerprint) return existing.key;

  const idempotencyKey = createKey();
  const record: StorageRecord = {
    version: RECORD_VERSION,
    key: idempotencyKey,
    fingerprint,
  };
  storage.setItem(key, JSON.stringify(record));
  return idempotencyKey;
}

export function completeIdempotentSubmit(
  storage: SubmitStorage,
  scope: IdempotencyScope,
  payload: unknown,
  idempotencyKey: string
): void {
  const key = storageKey(scope);
  const existing = readRecord(storage, key);
  if (
    existing?.key === idempotencyKey &&
    existing.fingerprint === fingerprintSubmitPayload(payload)
  ) {
    storage.removeItem(key);
  }
}

export function useIdempotentSubmit<TPayload>({
  operation,
  resource,
}: {
  operation: string;
  resource: string;
}) {
  const user = useCurrentUser();
  const userId = user?._id;
  const fallbackStorage = useRef(new Map<string, string>());

  const begin = useCallback(
    (payload: TPayload): string => {
      if (!userId) throw new Error("Sign in before submitting.");
      return beginIdempotentSubmit(
        browserStorage(fallbackStorage.current),
        { userId, operation, resource },
        payload,
        () => crypto.randomUUID()
      );
    },
    [operation, resource, userId]
  );

  const complete = useCallback(
    (payload: TPayload, idempotencyKey: string): void => {
      if (!userId) return;
      completeIdempotentSubmit(
        browserStorage(fallbackStorage.current),
        { userId, operation, resource },
        payload,
        idempotencyKey
      );
    },
    [operation, resource, userId]
  );

  return { begin, complete };
}
