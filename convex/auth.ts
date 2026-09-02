import { createClient, type GenericCtx } from "@convex-dev/better-auth";
import { convex } from "@convex-dev/better-auth/plugins";
import { betterAuth, type BetterAuthOptions } from "better-auth/minimal";
import { components } from "./_generated/api";
import { type DataModel } from "./_generated/dataModel";
import { query } from "./_generated/server";
import authConfig from "./auth.config";

// The URL of your app. Better Auth uses it for cookie security and redirects.
const siteUrl = process.env.SITE_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

// The component client has methods needed for integrating Convex with Better Auth,
// as well as helper methods for general use.
export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    trustedOrigins: [
      siteUrl,
      process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
      "http://localhost:3000",
    ],
    baseURL: siteUrl,
    database: authComponent.adapter(ctx),
    // Configure simple, non-verified email/password.
    // Set requireEmailVerification to true once email sending is configured.
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60, // Cache session for 1hours
      },
    },

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    plugins: [
      // The Convex plugin is required for Convex compatibility
      convex({ authConfig }),
    ],
  } satisfies BetterAuthOptions);

// Example function for getting the current user.
// Note: no `returns:` validator on purpose — the return type is inferred
// from the Better Auth component's user schema, which can gain fields
// (e.g. ban fields) between component versions; a hand-written validator
// would silently drift or reject valid documents.
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    return authComponent.safeGetAuthUser(ctx);
  },
});
