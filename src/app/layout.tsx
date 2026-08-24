import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";
import { ConvexClientProvider } from "./ConvexClientProvider";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/components/theme-provider";
import { getToken } from "@/lib/auth-server";
import { cn, setServerLang } from "@/lib/utils";

const ibmPlexSans = IBM_Plex_Sans({ subsets: ["latin"], variable: "--font-sans" });

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
      className={cn(
        "h-full antialiased",
        geistSans.variable,
        geistMono.variable,
        ibmPlexSans.variable,
        "font-sans",
      )}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <ConvexClientProvider initialToken={token} lang={lang}>
            {children}
            <Toaster position="top-center" />
          </ConvexClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
