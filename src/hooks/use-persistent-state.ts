"use client";

import { useCallback, useState, useSyncExternalStore } from "react";

const PREFIX = "pos:";

// One tiny module-level store so every component subscribed to the same key
// (e.g. two tables sharing a page-size preference) stays in sync. Values are
// cached in memory after the first read; localStorage is the backing copy.
const cache = new Map<string, unknown>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function readSnapshot<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  const cached = cache.get(key);
  if (cached !== undefined) return cached as T;
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    const value = raw != null ? (JSON.parse(raw) as T) : fallback;
    cache.set(key, value);
    return value;
  } catch {
    // Corrupt or unavailable storage — fall back to the in-memory default.
    return fallback;
  }
}

function writeSnapshot(key: string, value: unknown) {
  cache.set(key, value);
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage full/unavailable — state still works in memory.
  }
}

/**
 * useState that persists to localStorage — filters, page size, column order
 * and every other UI preference survive reloads (per the spec: "all UI state
 * persists in the browser"). useSyncExternalStore is the React-sanctioned
 * way to read a browser value once: the server snapshot is the initial
 * value, and the client re-renders with the stored value after hydration
 * without a mismatch.
 */
export function usePersistentState<T>(key: string, initial: T | (() => T)) {
  const [fallback] = useState<T>(initial);

  const subscribe = useCallback((onStoreChange: () => void) => {
    listeners.add(onStoreChange);
    return () => {
      listeners.delete(onStoreChange);
    };
  }, []);

  const state = useSyncExternalStore(
    subscribe,
    () => readSnapshot(key, fallback),
    () => fallback,
  );

  const setState = useCallback(
    (action: T | ((prev: T) => T)) => {
      const next =
        typeof action === "function"
          ? (action as (prev: T) => T)(readSnapshot(key, fallback))
          : action;
      writeSnapshot(key, next);
      emit();
    },
    [key, fallback],
  );

  return [state, setState] as const;
}
