"use client";

import { ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { ConvexReactClient } from "convex/react";
import { authClient } from "@/lib/auth-client";
import { setServerLang } from "@/lib/utils";
import type { Language } from "@/config/labels";
import {
  ConvexBetterAuthProvider,
  type AuthClient,
} from "@convex-dev/better-auth/react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export function ConvexClientProvider({
  children,
  initialToken,
  lang,
}: {
  children: ReactNode;
  initialToken?: string | null;
  lang: Language;
}) {
  // Client components SSR in their OWN module graph: RootLayout's
  // setServerLang call never reaches this instance of utils.ts, so its
  // default "en" would leak into the sidebar/nav HTML of a Khmer page.
  // Setting it here — before children render — makes the client-graph SSR
  // pass use the same language as the server-graph HTML around it, and
  // hydration matches. In the browser this call is inert: getLang() reads
  // localStorage / the pos_lang cookie first.
  setServerLang(lang);
  return (
    // Light/dark mode (next-themes): attribute="class" toggles the .dark
    // class on <html> — the token switch in globals.css. "system" follows
    // the OS preference until the user picks one; the choice persists in
    // localStorage under "theme" (the same key the init script in
    // layout.tsx reads before first paint). The Toaster reads the same
    // provider, so notifications follow the theme automatically.
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <ConvexBetterAuthProvider
        client={convex}
        // The provider's `AuthClient` type expects a specific createAuthClient
        // type parameter that the inferred client doesn't structurally overlap.
        // The runtime shape is compatible, so we go through `unknown` first.
        authClient={authClient as unknown as AuthClient}
        initialToken={initialToken}
      >
        {children}
      </ConvexBetterAuthProvider>
    </ThemeProvider>
  );
}
