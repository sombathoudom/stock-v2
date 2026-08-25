/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adjustments from "../adjustments.js";
import type * as auth from "../auth.js";
import type * as auth_credentials from "../auth_credentials.js";
import type * as backup from "../backup.js";
import type * as categories from "../categories.js";
import type * as channels from "../channels.js";
import type * as customers from "../customers.js";
import type * as dashboard from "../dashboard.js";
import type * as delivery from "../delivery.js";
import type * as deliveryCompanies from "../deliveryCompanies.js";
import type * as expenseCategories from "../expenseCategories.js";
import type * as expenses from "../expenses.js";
import type * as helpers from "../helpers.js";
import type * as http from "../http.js";
import type * as idempotency from "../idempotency.js";
import type * as lowStock from "../lowStock.js";
import type * as payments from "../payments.js";
import type * as pos from "../pos.js";
import type * as products from "../products.js";
import type * as purchases from "../purchases.js";
import type * as reports from "../reports.js";
import type * as sales from "../sales.js";
import type * as seed from "../seed.js";
import type * as shop from "../shop.js";
import type * as stock from "../stock.js";
import type * as suppliers from "../suppliers.js";
import type * as types from "../types.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  adjustments: typeof adjustments;
  auth: typeof auth;
  auth_credentials: typeof auth_credentials;
  backup: typeof backup;
  categories: typeof categories;
  channels: typeof channels;
  customers: typeof customers;
  dashboard: typeof dashboard;
  delivery: typeof delivery;
  deliveryCompanies: typeof deliveryCompanies;
  expenseCategories: typeof expenseCategories;
  expenses: typeof expenses;
  helpers: typeof helpers;
  http: typeof http;
  idempotency: typeof idempotency;
  lowStock: typeof lowStock;
  payments: typeof payments;
  pos: typeof pos;
  products: typeof products;
  purchases: typeof purchases;
  reports: typeof reports;
  sales: typeof sales;
  seed: typeof seed;
  shop: typeof shop;
  stock: typeof stock;
  suppliers: typeof suppliers;
  types: typeof types;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
