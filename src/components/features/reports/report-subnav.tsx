"use client";

import { ArrowDown01Icon, Analytics01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  availableReports,
  recommendedReports,
  reportNavItems,
  type ReportNavItem,
} from "@/config/reports";
import { cn, t } from "@/lib/utils";

export function ReportSubnav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const current =
    reportNavItems.find((item) => pathname === item.href) ?? availableReports[0];

  return (
    <>
      <div className="border-b p-4 lg:hidden">
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full justify-between"
          onClick={() => setOpen(true)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <HugeiconsIcon icon={current.icon} strokeWidth={2} className="size-4 shrink-0" />
            <span className="truncate">{t().reports[current.labelKey]}</span>
          </span>
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-4" />
        </Button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[88dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)] lg:hidden"
        >
          <SheetHeader className="border-b">
            <SheetTitle>{t().nav.reports}</SheetTitle>
            <SheetDescription>{t().reports.chooseReport}</SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-4 pb-4">
            <ReportLinkGroup
              title={t().reports.availableReports}
              items={availableReports}
              pathname={pathname}
              onNavigate={() => setOpen(false)}
            />
            <ReportLinkGroup
              title={t().reports.recommendedReports}
              items={recommendedReports}
              pathname={pathname}
              onNavigate={() => setOpen(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      <aside className="hidden w-64 shrink-0 border-r lg:block">
        <div className="sticky top-0 p-3">
          <div className="mb-3 flex items-center gap-2 px-2 py-1 font-heading font-medium">
            <HugeiconsIcon icon={Analytics01Icon} strokeWidth={2} className="size-5" />
            {t().nav.reports}
          </div>
          <ReportLinkGroup
            title={t().reports.availableReports}
            items={availableReports}
            pathname={pathname}
          />
          <ReportLinkGroup
            title={t().reports.recommendedReports}
            items={recommendedReports}
            pathname={pathname}
          />
        </div>
      </aside>
    </>
  );
}

function ReportLinkGroup({
  title,
  items,
  pathname,
  onNavigate,
}: {
  title: string;
  items: ReportNavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <div className="mt-3 first:mt-0">
      <p className="px-2 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <nav className="grid gap-1">
        {items.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              onClick={onNavigate}
              className={cn(
                "flex min-h-11 items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors",
                active
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              <HugeiconsIcon icon={item.icon} strokeWidth={2} className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t().reports[item.labelKey]}</span>
              {item.status === "comingSoon" ? (
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {t().common.comingSoon}
                </Badge>
              ) : null}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
