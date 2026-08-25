import type { MutationCtx, QueryCtx } from "./_generated/server";

import { components } from "./_generated/api";

// One tiny seam around Better Auth's credential account, which lives inside
// the betterAuth component's internal tables. Kept separate so user-management
// logic stays testable without running the component itself (convex-test
// cannot register components). Both helpers accept anything with `runQuery`
// / `runMutation`, so they work inside queries AND mutations.

/** The credential (email+password) account id for a Better Auth user, or
 * null when this person has no password sign-in yet. */
export async function findCredentialAccount(
  ctx: Pick<QueryCtx, "runQuery">,
  authUserId: string,
): Promise<{ accountId: string } | null> {
  const account = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "account",
    where: [
      { field: "userId", value: authUserId },
      { field: "providerId", value: "credential" },
    ],
  });
  if (!account || typeof account.accountId !== "string") return null;
  return { accountId: account.accountId };
}

/** Writes a new hashed password into the credential account row. */
export async function updateCredentialPassword(
  ctx: Pick<MutationCtx, "runMutation">,
  accountId: string,
  passwordHash: string,
): Promise<void> {
  await ctx.runMutation(
    components.betterAuth.adapter.updateOne,
    // Documented escape hatch: the generated updateOne union collapses to
    // its first member ("user") under contextual typing here; the account
    // member accepts exactly this shape (verified against the component's
    // schema), and the sign-in flow reads it back in production.
    {
      model: "account",
      where: [{ field: "accountId", value: accountId }],
      update: { password: passwordHash },
    } as never,
  );
}

/** The Better Auth user id for an email, or null when none exists. */
export async function findAuthUserIdByEmail(
  ctx: Pick<QueryCtx, "runQuery">,
  email: string,
): Promise<string | null> {
  const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: "user",
    where: [{ field: "email", value: email }],
  });
  if (!user) return null;
  const id = (user as { id?: unknown }).id ?? (user as { _id?: unknown })._id;
  return typeof id === "string" ? id : null;
}

/**
 * Creates the Better Auth user + credential account (the exact pair the
 * sign-up flow writes) and returns the new Better Auth user id.
 */
export async function createCredentialUser(
  ctx: Pick<MutationCtx, "runMutation">,
  input: { name: string; email: string; passwordHash: string },
): Promise<string> {
  const user = (await ctx.runMutation(
    components.betterAuth.adapter.create,
    {
      model: "user",
      data: { name: input.name, email: input.email, emailVerified: true },
    } as never,
  )) as { id?: unknown; _id?: unknown };
  const userId = user.id ?? user._id;
  if (typeof userId !== "string") {
    throw new Error("Better Auth user creation returned no id.");
  }
  await ctx.runMutation(
    components.betterAuth.adapter.create,
    {
      model: "account",
      data: {
        userId,
        accountId: userId,
        providerId: "credential",
        password: input.passwordHash,
      },
    } as never,
  );
  return userId;
}
