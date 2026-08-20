import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

import { authComponent } from "./auth";
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
