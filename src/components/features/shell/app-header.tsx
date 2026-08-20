"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ChevronDownIcon,
  ColorsIcon,
  FullScreenIcon,
  LanguageCircleIcon,
  Logout01Icon,
  Menu01Icon,
  MinimizeScreenIcon,
  Moon01Icon,
  Settings01Icon,
  ShoppingCart01Icon,
  Sun01Icon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useSyncExternalStore, useState } from "react";

import type { Language } from "@/config/labels";
import { useCurrentUser } from "@/hooks/use-current-user";
import { authClient } from "@/lib/auth-client";
import { cn, getLang, setLang, t, toastError } from "@/lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// The ONE global header, rendered by the app shell above every page:
// sidebar/menu trigger on the left; POS, theme, fullscreen, language and
// the profile menu on the right. Sticky, so the main controls stay visible
// while the page scrolls. Page-specific titles/search/actions live in the
// per-page PageToolbar — nothing here is duplicated on individual pages.

type AppHeaderProps = {
  /** True when the desktop/tablet sidebar is collapsed (drives the arrow icon). */
  sidebarCollapsed: boolean;
  /** Desktop/tablet: collapse or expand the sidebar. */
  onToggleSidebar: () => void;
  /** Phone: open the navigation drawer. */
  onOpenMenu: () => void;
};

export function AppHeader({
  sidebarCollapsed,
  onToggleSidebar,
  onOpenMenu,
}: AppHeaderProps) {
  const router = useRouter();
  const user = useCurrentUser();

  // "Has the client mounted?" — false on the server and during hydration,
  // true afterwards. Renders a deterministic first paint (light icon, no
  // fullscreen button), then flips to the real values — no mismatch.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // Light/dark toggle — next-themes owns the .dark class on <html> and the
  // saved choice (ConvexClientProvider); the init script in layout.tsx has
  // already applied the real theme before first paint.
  const { resolvedTheme, setTheme, theme } = useTheme();
  const isDark = mounted && resolvedTheme === "dark";
  const toggleTheme = () => setTheme(resolvedTheme === "dark" ? "light" : "dark");
  // "System" = nothing chosen yet; the radio keeps it checked until the
  // user picks light or dark explicitly.
  const currentTheme = theme ?? "system";

  // Fullscreen (desktop/tablet; hidden on phones and where unsupported,
  // e.g. iOS Safari). State follows the document via fullscreenchange so an
  // Esc exit stays in sync with the icon.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement != null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const fullscreenSupported = mounted && document.fullscreenEnabled === true;
  function toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(toastError);
    } else {
      document.documentElement.requestFullscreen().catch(toastError);
    }
  }

  async function signOut() {
    try {
      await authClient.signOut();
      router.push("/sign-in");
    } catch (err) {
      toastError(err);
    }
  }

  // Header icon buttons: 44×44 on phones (thumb ergonomics per AGENTS.md),
  // the standard size-9 from md up.
  const headerIconButton = "size-11 md:size-9";

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-1 border-b bg-background/95 px-3 backdrop-blur">
      {/* Left: drawer trigger on phones, sidebar collapse on tablet/desktop. */}
      <Button
        variant="ghost"
        size="icon"
        className={cn(headerIconButton, "md:hidden")}
        aria-label={t().nav.more}
        onClick={onOpenMenu}
      >
        <HugeiconsIcon icon={Menu01Icon} strokeWidth={2} className="size-5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn(headerIconButton, "hidden md:inline-flex")}
        aria-label={
          sidebarCollapsed ? t().common.expandSidebar : t().common.collapseSidebar
        }
        onClick={onToggleSidebar}
      >
        <HugeiconsIcon
          icon={sidebarCollapsed ? ArrowRight01Icon : ArrowLeft01Icon}
          strokeWidth={2}
          className="size-5"
        />
      </Button>

      {/* Right: POS, theme, fullscreen, language, profile. */}
      <div className="ms-auto flex items-center gap-1">
        {/* POS checkout — renders full-bleed, outside this shell. */}
        <Link
          href="/sales/new"
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "h-11 md:h-8")}
        >
          <HugeiconsIcon icon={ShoppingCart01Icon} strokeWidth={2} className="size-4" />
          <span className="hidden sm:inline">{t().common.pos}</span>
        </Link>

        <Button
          variant="ghost"
          size="icon"
          className={headerIconButton}
          aria-label={isDark ? t().common.lightMode : t().common.darkMode}
          onClick={toggleTheme}
        >
          <HugeiconsIcon icon={isDark ? Sun01Icon : Moon01Icon} strokeWidth={2} className="size-5" />
        </Button>

        {fullscreenSupported && (
          <Button
            variant="ghost"
            size="icon"
            className={cn(headerIconButton, "hidden sm:inline-flex")}
            aria-label={isFullscreen ? t().common.exitFullscreen : t().common.enterFullscreen}
            onClick={toggleFullscreen}
          >
            <HugeiconsIcon
              icon={isFullscreen ? MinimizeScreenIcon : FullScreenIcon}
              strokeWidth={2}
              className="size-5"
            />
          </Button>
        )}

        {/* Language — the labels module reads localStorage per render and has
            no reactive store, so switching reloads the page; filters and
            pagination survive it via usePersistentState. The pos_lang cookie
            keeps the server HTML and hydration in the same language. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className={headerIconButton}
                aria-label={t().common.language}
              />
            }
          >
            <HugeiconsIcon icon={LanguageCircleIcon} strokeWidth={2} className="size-5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t().common.language}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={getLang()}
                onValueChange={(value) => {
                  const lang = value as Language;
                  if (lang === getLang()) return;
                  setLang(lang);
                  window.location.reload();
                }}
              >
                <DropdownMenuRadioItem value="en">
                  {t().common.languageEnglish}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="km">
                  {t().common.languageKhmer}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Profile: who's signed in + settings / appearance / sign out. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="h-11 gap-1.5 md:h-8"
                aria-label={t().common.profile}
              />
            }
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
              {user != null ? user.name.slice(0, 1).toUpperCase() : "?"}
            </span>
            <span className="hidden max-w-28 truncate text-sm font-medium md:inline">
              {user?.name ?? ""}
            </span>
            <HugeiconsIcon
              icon={ChevronDownIcon}
              strokeWidth={2}
              className="hidden size-3.5 text-muted-foreground md:inline-flex"
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="flex flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground">
                  {user?.name ?? "—"}
                </span>
                {user != null && (
                  <span className="text-xs font-normal text-muted-foreground">
                    {user.role === "owner" ? t().common.roleOwner : t().common.roleStaff}
                  </span>
                )}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            {/* Settings is owner-only, same as the nav item. */}
            {user?.role === "owner" && (
              <DropdownMenuItem onClick={() => router.push("/settings")}>
                <HugeiconsIcon icon={Settings01Icon} strokeWidth={2} />
                {t().nav.settings}
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <HugeiconsIcon icon={ColorsIcon} strokeWidth={2} />
                {t().common.appearance}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent alignOffset={-4}>
                <DropdownMenuRadioGroup
                  value={currentTheme}
                  onValueChange={(value) => setTheme(value)}
                >
                  <DropdownMenuRadioItem value="light">
                    {t().common.lightMode}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="dark">
                    {t().common.darkMode}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="system">
                    {t().common.themeSystem}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={signOut}>
              <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
              {t().common.signOut}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
