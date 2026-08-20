"use client";

import { useQuery } from "convex/react";

import { api } from "@convex/_generated/api";

/**
 * The shop settings (name, currency, timezone, delivery module, …) —
 * undefined while loading, null until the first owner saves settings.
 * One shared read so every screen sees the same fresh settings.
 */
export function useShop() {
  return useQuery(api.shop.get);
}
