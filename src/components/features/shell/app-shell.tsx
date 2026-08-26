"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Logout01Icon, Store01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";

import { api } from "@convex/_generated/api";
import { AppHeader } from "@/components/features/shell/app-header";
import { visibleNavItems, type NavItem } from "@/config/nav";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { useShop } from "@/hooks/use-shop";
import { authClient } from "@/lib/auth-client";
import { cn, t, toastError } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

// Responsive app shell rendered from src/config/nav.ts — adding a page never
// means editing shell JSX. Desktop: collapsible sidebar. Tablet: the same
// sidebar icon-only by default, expandable. Phone: bottom nav + a drawer
// opened from the AppHeader menu button. The GLOBAL AppHeader (POS, theme,
// fullscreen, language, profile) is rendered once above every page's
// content; the active nav item is always highlighted.

function isActive(pathname: string, href: string) {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(href + "/");
}

function NavIcon({ item }: { item: NavItem }) {
  return <HugeiconsIcon icon={item.icon} strokeWidth={2} className="size-5 shrink-0" />;
}

/** T23 — the low-stock alert badge shown on the Stock nav item: a small
 * destructive count pill. In the collapsed sidebar / bottom nav it overlays
 * the icon; in the expanded sidebar and the drawer it sits right-aligned. */
function LowStockBadge({ count, overlay }: { count: number; overlay: boolean }) {
  return (
    <span
      aria-label={t().stock.lowStockBadgeAria.replace("{n}", String(count))}
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground",
        overlay ? "absolute -end-0.5 -top-0.5" : "ms-auto shrink-0",
      )}
    >
      {count}
    </span>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const user = useCurrentUser();
  const shop = useShop();
  const [collapsed, setCollapsed] = usePersistentState("shell:collapsed", false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Track which parent nav items are expanded (children visible).
  const [expandedItems, setExpandedItems] = usePersistentState<Record<string, boolean>>(
    "shell:expanded",
    {},
  );
  function toggleExpanded(href: string) {
    setExpandedItems((prev) => ({ ...prev, [href]: !prev[href] }));
  }
  // Tablet (768–1023) shows the sidebar icon-only by default, expandable via
  // the same toggle. Desktop keeps the persisted preference; the tablet's
  // expand state is session-only so it never changes the desktop layout.
  const [belowLg, setBelowLg] = useState(false);
  const [tabletExpanded, setTabletExpanded] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const update = () => setBelowLg(!mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const effectiveCollapsed = belowLg ? !tabletExpanded : collapsed;

  // The alert count that follows the owner on every page — same shared walk
  // as the dashboard card and the stock page list, so it never disagrees.
  const lowStockCount = useQuery(api.lowStock.lowStockCount, user == null ? "skip" : {});
  const lowCount = lowStockCount?.count ?? 0;

  function toggleSidebar() {
    if (belowLg) setTabletExpanded((e) => !e);
    else setCollapsed((c) => !c);
  }

  // Role-filtered navigation: items without roles are for everyone; role
  // items only appear once the current user's role is known. Items that
  // need the delivery module appear only while shop settings are loading
  // or the module is on — so a shop with delivery off never sees them.
  const items = visibleNavItems.filter(
    (item) =>
      (!item.roles || (user != null && item.roles.includes(user.role))) &&
      (!item.requiresDelivery || shop == null || shop.deliveryEnabled),
  );
  const bottomItems = items.filter((item) => item.inBottomNav);

  async function signOut() {
    try {
      await authClient.signOut();
      router.push("/sign-in");
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <div className="min-h-dvh bg-background">
      {/* Desktop + tablet sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 start-0 z-40 hidden flex-col border-e bg-background transition-all md:flex",
          effectiveCollapsed ? "w-14" : "w-64",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-3">
          <HugeiconsIcon icon={Store01Icon} strokeWidth={2} className="size-6 shrink-0 text-primary" />
          {!effectiveCollapsed && (
            <span className="truncate font-heading text-base font-semibold">{t().appName}</span>
          )}
        </div>

        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
          {items.map((item) => {
            const isStock = item.labelKey === "stock";
            const hasChildren = item.children && item.children.length > 0;
            const isExpanded = expandedItems[item.href] ?? false;
            const childActive = hasChildren && item.children!.some((child) => isActive(pathname, child.href));
            return (
              <div key={item.href}>
                {hasChildren ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (effectiveCollapsed) return;
                      toggleExpanded(item.href);
                    }}
                    title={effectiveCollapsed ? t().nav[item.labelKey] : undefined}
                    className={cn(
                      "relative flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      (isActive(pathname, item.href) || childActive)
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      effectiveCollapsed && "justify-center px-0",
                    )}
                  >
                    <NavIcon item={item} />
                    {!effectiveCollapsed && (
                      <>
                        <span className="truncate">{t().nav[item.labelKey]}</span>
                        <HugeiconsIcon
                          icon={ArrowDown01Icon}
                          strokeWidth={2}
                          className={cn(
                            "ms-auto size-4 shrink-0 transition-transform",
                            isExpanded && "rotate-180",
                          )}
                        />
                      </>
                    )}
                    {isStock && lowCount > 0 && (
                      <LowStockBadge count={lowCount} overlay={effectiveCollapsed} />
                    )}
                  </button>
                ) : (
                  <Link
                    href={item.href}
                    aria-current={isActive(pathname, item.href) ? "page" : undefined}
                    title={effectiveCollapsed ? t().nav[item.labelKey] : undefined}
                    className={cn(
                      "relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                      isActive(pathname, item.href)
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      effectiveCollapsed && "justify-center px-0",
                    )}
                  >
                    <NavIcon item={item} />
                    {!effectiveCollapsed && <span className="truncate">{t().nav[item.labelKey]}</span>}
                    {isStock && lowCount > 0 && (
                      <LowStockBadge count={lowCount} overlay={effectiveCollapsed} />
                    )}
                  </Link>
                )}
                {/* Sub-items: indented, only visible when expanded and not collapsed. */}
                {hasChildren && isExpanded && !effectiveCollapsed && (
                  <div className="ms-4 flex flex-col gap-0.5 border-s ps-3">
                    {item.children!.map((child) => (
                      <Link
                        key={child.href}
                        href={child.href}
                        aria-current={isActive(pathname, child.href) ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors",
                          isActive(pathname, child.href)
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <HugeiconsIcon icon={child.icon} strokeWidth={2} className="size-4 shrink-0" />
                        <span className="truncate">{t().nav[child.labelKey]}</span>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <Separator />
        {/* Sign out / theme / collapse now live in the global AppHeader —
            this footer only shows who is signed in. */}
        <div className="p-2">
          {!effectiveCollapsed && user != null && (
            <div className="flex items-center gap-2 px-2 py-1">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{user.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {user.role === "owner" ? t().common.roleOwner : t().common.roleStaff}
                </span>
              </span>
            </div>
          )}
        </div>
      </aside>

      {/* Mobile nav drawer — opened from the AppHeader menu button. */}
      <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
        <SheetContent side="left" className="w-72 gap-0 p-0">
          <SheetTitle className="sr-only">{t().nav.more}</SheetTitle>
          <div className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <HugeiconsIcon icon={Store01Icon} strokeWidth={2} className="size-6 shrink-0 text-primary" />
            <span className="truncate font-heading text-base font-semibold">{t().appName}</span>
          </div>
          <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-2">
            {items.map((item) => {
              const hasChildren = item.children && item.children.length > 0;
              const isExpanded = expandedItems[item.href] ?? false;
              const childActive = hasChildren && item.children!.some((child) => isActive(pathname, child.href));
              return (
                <div key={item.href}>
                  {hasChildren ? (
                    <button
                      type="button"
                      onClick={() => toggleExpanded(item.href)}
                      className={cn(
                        "relative flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        (isActive(pathname, item.href) || childActive)
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <NavIcon item={item} />
                      <span className="truncate">{t().nav[item.labelKey]}</span>
                      <HugeiconsIcon
                        icon={ArrowDown01Icon}
                        strokeWidth={2}
                        className={cn(
                          "ms-auto size-4 shrink-0 transition-transform",
                          isExpanded && "rotate-180",
                        )}
                      />
                    </button>
                  ) : (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setDrawerOpen(false)}
                      aria-current={isActive(pathname, item.href) ? "page" : undefined}
                      className={cn(
                        "relative flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        isActive(pathname, item.href)
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      <NavIcon item={item} />
                      <span className="truncate">{t().nav[item.labelKey]}</span>
                      {item.labelKey === "stock" && lowCount > 0 && (
                        <LowStockBadge count={lowCount} overlay={false} />
                      )}
                    </Link>
                  )}
                  {hasChildren && isExpanded && (
                    <div className="ms-4 flex flex-col gap-0.5 border-s ps-3">
                      {item.children!.map((child) => (
                        <Link
                          key={child.href}
                          href={child.href}
                          onClick={() => setDrawerOpen(false)}
                          aria-current={isActive(pathname, child.href) ? "page" : undefined}
                          className={cn(
                            "flex items-center gap-3 rounded-md px-3 py-1.5 text-sm transition-colors",
                            isActive(pathname, child.href)
                              ? "bg-primary/10 text-primary font-medium"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          <HugeiconsIcon icon={child.icon} strokeWidth={2} className="size-4 shrink-0" />
                          <span className="truncate">{t().nav[child.labelKey]}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          <Separator />
          <div className="p-2">
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={signOut}>
              <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} className="size-4" />
              {t().common.signOut}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Content: the global AppHeader (sticky) above every page. */}
      <main
        className={cn(
          "min-h-dvh w-full transition-all",
          bottomItems.length > 0 &&
            "pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0",
          effectiveCollapsed ? "md:ps-14" : "md:ps-64",
        )}
      >
        <AppHeader
          sidebarCollapsed={effectiveCollapsed}
          onToggleSidebar={toggleSidebar}
          onOpenMenu={() => setDrawerOpen(true)}
        />
        {children}
      </main>

      {/* Mobile bottom nav (grid class + md:hidden — no inline display, which
          would override the Tailwind class) */}
      {bottomItems.length > 0 && (
        <nav
          className="fixed inset-x-0 bottom-0 z-40 grid border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
          style={{
            gridTemplateColumns: `repeat(${bottomItems.length}, minmax(0, 1fr))`,
          }}
        >
          {bottomItems.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <span className="relative">
                  <HugeiconsIcon icon={item.icon} strokeWidth={2} className="size-5" />
                  {item.labelKey === "stock" && lowCount > 0 && (
                    <LowStockBadge count={lowCount} overlay />
                  )}
                </span>
                <span className="truncate">{t().nav[item.labelKey]}</span>
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
