import type { Metadata } from "next";
import Script from "next/script";
import { cookies } from "next/headers";
import { Geist, Geist_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { Toaster } from "@/components/ui/sonner";
import { getToken } from "@/lib/auth-server";
import { cn, setServerLang } from "@/lib/utils";

const ibmPlexSans = IBM_Plex_Sans({subsets:['latin'],variable:'--font-sans'});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "My POS",
  description: "Point of sale app",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const token = await getToken();
  // Language from the pos_lang cookie (set by the header's language
  // selector): render the server HTML in the same language the client
  // hydrates with, and set <html lang> for screen readers.
  const langCookie = (await cookies()).get("pos_lang")?.value;
  const lang = langCookie === "km" ? "km" : "en";
  setServerLang(lang);
  return (
    <html
      lang={lang}
      suppressHydrationWarning
      className={cn("h-full", "antialiased", geistSans.variable, geistMono.variable, "font-sans", ibmPlexSans.variable)}
    >
      <body className="min-h-full flex flex-col">
        {/* Theme before first paint: the .dark class on <html> drives every
            shadcn token (globals.css ships both sets). The saved choice — or
            the OS preference — must be applied before React loads, so a
            reload never flashes the wrong mode. next-themes (ThemeProvider in
            ConvexClientProvider) reads the same localStorage "theme" key. */}
        <Script id="theme-init" strategy="beforeInteractive">
          {`try {
            var t = localStorage.getItem("theme");
            var dark = t === "dark" || (t !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
            if (dark) document.documentElement.classList.add("dark");
          } catch (e) {}`}
        </Script>
        <ConvexClientProvider initialToken={token} lang={lang}>
          {children}
          <Toaster />
        </ConvexClientProvider>
      </body>
    </html>
  );
}
