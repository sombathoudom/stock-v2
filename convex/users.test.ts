import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const OWNER_AUTH_ID = "users-owner";
const STAFF_AUTH_ID = "users-staff";
const TARGET_AUTH_ID = "users-target";

// Sign-in is faked per scenario; everything under it runs for real.
const authState = vi.hoisted(() => ({
  current: null as { _id: string; name: string; email: string } | null,
}));

// In-memory stand-in for Better Auth's credential accounts. The REAL
// component's CRUD can't run under convex-test (components aren't
// registered there), so this stub verifies exactly what our mutation does:
// find by (userId, providerId=credential) → hash → write password.
const accounts = vi.hoisted(() => ({
  byAuthUserId: new Map<string, string>(),
  emailToAuthUser: new Map<string, string>(),
}));

vi.mock("./auth", () => ({
  authComponent: {
    safeGetAuthUser: async () => authState.current,
  },
  createAuth: () => ({
    // Real Better Auth exposes $context as a Promise.
    $context: (async () => ({
      password: {
        hash: async (plain: string) => `hashed:${plain}`,
        verify: async (hash: string, plain: string) => hash === `hashed:${plain}`,
      },
    }))(),
  }),
}));

vi.mock("./auth_credentials", () => ({
  findCredentialAccount: async (_ctx: unknown, authUserId: string) => {
    if (!accounts.byAuthUserId.has(authUserId)) return null;
    return { accountId: `acc-${authUserId}` };
  },
  updateCredentialPassword: async (
    _ctx: unknown,
    accountId: string,
    passwordHash: string,
  ) => {
    if (!accountId.startsWith("acc-")) {
      throw new Error(`Unknown account ${accountId}`);
    }
    accounts.byAuthUserId.set(accountId.slice(4), passwordHash);
  },
  findAuthUserIdByEmail: async (_ctx: unknown, email: string) => {
    const authUserId = accounts.emailToAuthUser.get(email);
    return authUserId ?? null;
  },
  createCredentialUser: async (
    _ctx: unknown,
    input: { name: string; email: string; passwordHash: string },
  ) => {
    const authUserId = `auth-${input.email}`;
    accounts.byAuthUserId.set(authUserId, input.passwordHash);
    accounts.emailToAuthUser.set(input.email, authUserId);
    return authUserId;
  },
}));

const modules = import.meta.glob("./**/*.ts");

type TestContext = ReturnType<typeof convexTest>;

function signIn(authUserId: string | null) {
  authState.current = authUserId
    ? { _id: authUserId, name: "Signed In", email: `${authUserId}@t.local` }
    : null;
}

async function seed(t: TestContext) {
  signIn(OWNER_AUTH_ID);
  accounts.byAuthUserId.clear();
  accounts.emailToAuthUser.clear();
  accounts.byAuthUserId.set(TARGET_AUTH_ID, "old-hash");
  accounts.emailToAuthUser.set(`${TARGET_AUTH_ID}@t.local`, TARGET_AUTH_ID);
  return await t.run(async (ctx) => {
    await ctx.db.insert("shop", {
      name: "Team Shop",
      currency: "USD",
      exchangeRate: 4000,
      timezone: "Asia/Phnom_Penh",
      deliveryEnabled: false,
      language: "en" as const,
    });
    const ownerId = await ctx.db.insert("users", {
      authUserId: OWNER_AUTH_ID,
      name: "Owner",
      email: `${OWNER_AUTH_ID}@t.local`,
      role: "owner" as const,
      active: true,
    });
    const staffId = await ctx.db.insert("users", {
      authUserId: STAFF_AUTH_ID,
      name: "Staff Sam",
      email: `${STAFF_AUTH_ID}@t.local`,
      role: "staff" as const,
      active: true,
    });
    const targetId = await ctx.db.insert("users", {
      authUserId: TARGET_AUTH_ID,
      name: "Target Tida",
      email: `${TARGET_AUTH_ID}@t.local`,
      role: "staff" as const,
      active: true,
    });
    const deactivatedId = await ctx.db.insert("users", {
      authUserId: "users-deactivated",
      name: "Old Sopheak",
      email: "old@t.local",
      role: "staff" as const,
      active: false,
    });
    accounts.emailToAuthUser.set("old@t.local", "users-deactivated");
    return { ownerId, staffId, targetId, deactivatedId };
  });
}

describe("users.setActive", () => {
  test("deactivates and reactivates a staff member", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    const off = await t.mutation(api.users.setActive, {
      userId: ids.targetId as Id<"users">,
      active: false,
    });
    expect(off.active).toBe(false);

    const on = await t.mutation(api.users.setActive, {
      userId: ids.targetId as Id<"users">,
      active: true,
    });
    expect(on.active).toBe(true);
  });

  test("refuses deactivating yourself", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await expect(
      t.mutation(api.users.setActive, { userId: ids.ownerId, active: false }),
    ).rejects.toThrow();
  });

  test("staff cannot manage anyone", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    signIn(STAFF_AUTH_ID);
    await expect(
      t.mutation(api.users.setActive, { userId: ids.targetId, active: false }),
    ).rejects.toThrow();
  });

  test("unauthenticated callers are rejected before anything else", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    signIn(null);
    await expect(
      t.mutation(api.users.setActive, { userId: ids.targetId, active: false }),
    ).rejects.toThrow();
  });
});

describe("users.resetPassword", () => {
  test("writes a new credential hash for the target staff account", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    await t.mutation(api.users.resetPassword, {
      userId: ids.targetId,
      newPassword: "brand-new-pass",
    });

    // Hashed through Better Auth's hasher into the credential account.
    expect(accounts.byAuthUserId.get(TARGET_AUTH_ID)).toBe("hashed:brand-new-pass");
  });

  test("rejects short passwords without touching the account", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await expect(
      t.mutation(api.users.resetPassword, {
        userId: ids.targetId,
        newPassword: "short",
      }),
    ).rejects.toThrow();
    expect(accounts.byAuthUserId.get(TARGET_AUTH_ID)).toBe("old-hash");
  });

  test("refuses resetting your own password here", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await expect(
      t.mutation(api.users.resetPassword, {
        userId: ids.ownerId,
        newPassword: "whatever-pass",
      }),
    ).rejects.toThrow();
  });

  test("deactivated staff cannot be reset", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    await expect(
      t.mutation(api.users.resetPassword, {
        userId: ids.deactivatedId,
        newPassword: "brand-new-pass",
      }),
    ).rejects.toThrow();
  });

  test("staff cannot reset anyone's password", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);
    signIn(STAFF_AUTH_ID);
    await expect(
      t.mutation(api.users.resetPassword, {
        userId: ids.targetId,
        newPassword: "brand-new-pass",
      }),
    ).rejects.toThrow();
  });
});

describe("users.createStaff", () => {
  test("creates the sign-in and staff record with the chosen role", async () => {
    const t = convexTest(schema, modules);
    await seed(t);

    const created = await t.mutation(api.users.createStaff, {
      name: "New Nimol",
      email: "nimol@t.local",
      password: "starting-pass",
      role: "staff" as const,
    });

    expect(created.email).toBe("nimol@t.local");
    expect(created.role).toBe("staff");
    expect(created.active).toBe(true);
    // The credential account exists for the new identity.
    expect(accounts.byAuthUserId.get(created.authUserId)).toBe(
      "hashed:starting-pass",
    );
  });

  test("refuses duplicate emails (auth store or staff list)", async () => {
    const t = convexTest(schema, modules);
    const ids = await seed(t);

    // Taken in the Better Auth table.
    await expect(
      t.mutation(api.users.createStaff, {
        name: "Dup One",
        email: `${TARGET_AUTH_ID}@t.local`,
        password: "starting-pass",
        role: "staff" as const,
      }),
    ).rejects.toThrow();

    // Taken in our staff list (deactivated counts too).
    await expect(
      t.mutation(api.users.createStaff, {
        name: "Dup Two",
        email: "old@t.local",
        password: "starting-pass",
        role: "staff" as const,
      }),
    ).rejects.toThrow();
    void ids;
  });

  test("rejects invalid email and short passwords", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    await expect(
      t.mutation(api.users.createStaff, {
        name: "Bad Email",
        email: "not-an-email",
        password: "starting-pass",
        role: "staff" as const,
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(api.users.createStaff, {
        name: "Short Pass",
        email: "short@t.local",
        password: "short",
        role: "staff" as const,
      }),
    ).rejects.toThrow();
  });

  test("staff cannot invite anyone", async () => {
    const t = convexTest(schema, modules);
    await seed(t);
    signIn(STAFF_AUTH_ID);
    await expect(
      t.mutation(api.users.createStaff, {
        name: "Sneaky",
        email: "sneaky@t.local",
        password: "starting-pass",
        role: "owner" as const,
      }),
    ).rejects.toThrow();
  });
});
