import { isAuthenticated } from "@/lib/auth-server";
import { redirect } from "next/navigation";
import { PropsWithChildren } from "react";

// POS routes render FULL-BLEED — no AppShell, no sidebar, no bottom nav.
// The checkout screen owns its viewport (the compact desktop POS design) and
// needs every pixel: this group keeps /sales/new out of the (auth) shell
// while the URL stays identical. Auth is still enforced server-side, exactly
// like (auth)/layout, and every Convex function re-checks via requireUser.
export default async function PosLayout({ children }: PropsWithChildren) {
  if (!(await isAuthenticated())) {
    redirect("/sign-in");
  }
  return children;
}
