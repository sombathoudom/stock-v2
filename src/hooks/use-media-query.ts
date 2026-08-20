"use client";

import { useSyncExternalStore } from "react";

// Subscribe to a CSS media query. SSR-safe: the server snapshot is false,
// so the initial server HTML matches hydration; the client value applies
// immediately after. Used by the POS to pick Dialog (desktop) vs Sheet
// (phone) for the order popup.

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onStoreChange);
      return () => mql.removeEventListener("change", onStoreChange);
    },
    () => window.matchMedia(query).matches,
    () => false
  );
}
