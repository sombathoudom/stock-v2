"use client";

import { useMutation, useQuery } from "convex/react";
import { useEffect } from "react";

import { api } from "@convex/_generated/api";
import { authClient } from "@/lib/auth-client";
import { toastError } from "@/lib/utils";

/**
 * The signed-in staff profile (id, name, email, role) — undefined while
 * loading, null when there is no profile yet (first sign-in or the auth
 * token hasn't reached the Convex client). On first sign-in it provisions
 * the staff record once the better-auth session is loaded; the Convex
 * query then refills itself reactively.
 */
export function useCurrentUser() {
  const me = useQuery(api.users.me);
  const ensureMe = useMutation(api.users.ensureMe);
  const { data: session } = authClient.useSession();

  useEffect(() => {
    // Provision only once the session exists — the Convex token attaches
    // alongside it, so ensureMe won't race it.
    if (me === null && session) {
      ensureMe().catch(toastError);
    }
  }, [me, session, ensureMe]);

  return me;
}
