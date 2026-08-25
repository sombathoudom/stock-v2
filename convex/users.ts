import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { authComponent, createAuth } from "./auth";
import {
  createCredentialUser,
  findAuthUserIdByEmail,
  findCredentialAccount,
  updateCredentialPassword,
} from "./auth_credentials";
import { mutation, query } from "./_generated/server";
import { ensureStaff, requireOwner, requireOwnerQuery } from "./helpers";
import { userDoc, userRole } from "./types";

// The signed-in staff member's own safe profile. This is ALL the client ever
// receives from the session: id, name, email, role — no tokens, no other
// users, nothing else.
// Returns null (NOT an error) when there is no staff record yet OR the auth
// token hasn't reached the Convex client (a known race on fresh page loads).
// A throwing query would crash the shell before the provision effect can run;
// the shell treats null as "no profile yet" and everything refills reactively.
export const me = query({
  args: {},
  returns: v.union(userDoc, v.null()),
  handler: async (ctx) => {
    const authUser = await authComponent.safeGetAuthUser(ctx);
    if (!authUser) return null;
    const staff = await ctx.db
      .query("users")
      .withIndex("by_authUserId", (q) => q.eq("authUserId", authUser._id))
      .first();
    return staff && staff.active ? staff : null;
  },
});

// Idempotent: creates the staff record on first sign-in (first user ever →
// owner, later users → staff). Returns null when the auth token isn't
// attached yet — the client retries once its session is loaded.
export const ensureMe = mutation({
  args: {},
  returns: v.union(userDoc, v.null()),
  handler: async (ctx) => {
    const authUser = await authComponent.safeGetAuthUser(ctx);
    if (!authUser) return null;
    const { staff } = await ensureStaff(ctx);
    return staff;
  },
});

// The team list — OWNER ONLY (staff can never see other people's data).
// Paginated for the shared DataTable. total is bounded with take(1000):
// a team table beyond 1000 staff is unrealistic for one shop.
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(userDoc),
    continueCursor: v.string(),
    total: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireOwnerQuery(ctx);
    const page = await ctx.db.query("users").order("asc").paginate(args.paginationOpts);
    const total = (await ctx.db.query("users").take(1000)).length;
    return { page: page.page, continueCursor: page.isDone ? "" : page.continueCursor, total };
  },
});

// Change a staff member's role. The owner cannot change their own role here
// (prevents a shop with no owner left behind).
export const setRole = mutation({
  args: { userId: v.id("users"), role: userRole },
  returns: userDoc,
  handler: async (ctx, args) => {
    const { staff: actor } = await requireOwner(ctx);
    if (args.userId === actor._id) {
      throw new ConvexError({
        code: "CANNOT_CHANGE_OWN_ROLE",
        message: "You can't change your own role.",
      });
    }
    const target = await ctx.db.get(args.userId);
    if (!target || !target.active) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Staff record not found." });
    }
    await ctx.db.patch(args.userId, { role: args.role });
    return (await ctx.db.get(args.userId))!;
  },
});

// Deactivate / reactivate a staff member (soft-delete — history stays).
// Deactivated staff fail requireUser with NO_STAFF_RECORD, so they can't
// sign in to the app; their past orders/ledger rows keep their name. The
// owner cannot deactivate themselves (a shop is left without an owner).
export const setActive = mutation({
  args: { userId: v.id("users"), active: v.boolean() },
  returns: userDoc,
  handler: async (ctx, args) => {
    const { staff: actor } = await requireOwner(ctx);
    if (args.userId === actor._id) {
      throw new ConvexError({
        code: "CANNOT_DEACTIVATE_SELF",
        message: "You can't deactivate your own account.",
      });
    }
    const target = await ctx.db.get(args.userId);
    if (!target) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Staff record not found." });
    }
    await ctx.db.patch(args.userId, { active: args.active });
    return (await ctx.db.get(args.userId))!;
  },
});

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Owner invites a staff member: creates the Better Auth sign-in (email +
 * starting password) AND the staff record in one transaction, with the
 * role chosen up front — no public-signup detour needed. Duplicate emails
 * are refused whether they belong to an active or deactivated account.
 */
export const createStaff = mutation({
  args: {
    name: v.string(),
    email: v.string(),
    password: v.string(),
    role: userRole,
  },
  returns: userDoc,
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const email = args.email.trim();
    if (
      email.length < 3 ||
      email.length > 200 ||
      !EMAIL_RE.test(email)
    ) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Enter a valid email." });
    }
    const name = args.name.trim().slice(0, 100);
    if (name.length === 0) {
      throw new ConvexError({ code: "INVALID_INPUT", message: "Enter a name." });
    }
    const password = args.password.trim();
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`,
      });
    }

    // One identity per email across BOTH stores: Better Auth's own table
    // first (the sign-in source of truth), then our staff list.
    if ((await findAuthUserIdByEmail(ctx, email)) !== null) {
      throw new ConvexError({
        code: "DUPLICATE_EMAIL",
        message: "That email already has an account.",
      });
    }
    const existingStaff = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email))
      .first()
      .then((row) => row ?? null)
      .catch(() => null);
    if (existingStaff) {
      throw new ConvexError({
        code: "DUPLICATE_EMAIL",
        message: "That email already has an account.",
      });
    }

    // Hash with Better Auth's hasher, create its user + credential account,
    // then link our staff row to it.
    const auth = createAuth(ctx);
    const context = await auth.$context;
    const passwordHash = await context.password.hash(password);
    const authUserId = await createCredentialUser(ctx, {
      name,
      email,
      passwordHash,
    });

    const staffId = await ctx.db.insert("users", {
      authUserId,
      name,
      email,
      role: args.role,
      active: true,
    });
    return (await ctx.db.get(staffId))!;
  },
});

/**
 * Owner sets a NEW password for a staff member (they forgot theirs). The
 * hash runs through Better Auth's own hasher and lands in its credential
 * account row — the same place `signUp.email` writes — so the next sign-in
 * uses it directly. Self-reset is refused on purpose: changing your own
 * password must prove the old one.
 */
export const resetPassword = mutation({
  args: { userId: v.id("users"), newPassword: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { staff: actor } = await requireOwner(ctx);
    if (args.userId === actor._id) {
      throw new ConvexError({
        code: "CANNOT_RESET_OWN_PASSWORD",
        message: "Use change password for your own account.",
      });
    }
    const target = await ctx.db.get(args.userId);
    if (!target || !target.active) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Staff record not found." });
    }
    const newPassword = args.newPassword.trim();
    if (
      newPassword.length < PASSWORD_MIN ||
      newPassword.length > PASSWORD_MAX
    ) {
      throw new ConvexError({
        code: "INVALID_INPUT",
        message: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters.`,
      });
    }

    // Hash with Better Auth's configured hasher (scrypt by default), then
    // write it into the component's credential account via the seam module.
    const auth = createAuth(ctx);
    const context = await auth.$context;
    const hash = await context.password.hash(newPassword);

    const account = await findCredentialAccount(ctx, target.authUserId);
    if (!account) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: "No password sign-in exists for this staff member.",
      });
    }
    await updateCredentialPassword(ctx, account.accountId, hash);
    return null;
  },
});
