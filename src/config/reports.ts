import {
  Analytics01Icon,
  Calculator01Icon,
  ClipboardCheckIcon,
  Contact01Icon,
  Link01Icon,
  PackageReceive01Icon,
  Shirt01Icon,
  WarehouseIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

// The reports catalog — every entry is a BUILT, full-page report reached from
// the main app sidebar's "Reports" submenu (src/config/nav.ts). There is no
// in-page report menu and no "coming soon" placeholders.

export type ReportLabelKey =
  | "reportPl"
  | "reportChannels"
  | "reportStock"
  | "reportCustomerDebt"
  | "reportProductPerformance"
  | "reportInventoryValue"
  | "reportDeadStock"
  | "reportReorder";

export type ReportNavItem = {
  slug: string;
  href: string;
  labelKey: ReportLabelKey;
  icon: IconSvgElement;
};

export const availableReports: ReportNavItem[] = [
  {
    slug: "profit-loss",
    href: "/reports/profit-loss",
    labelKey: "reportPl",
    icon: Analytics01Icon,
  },
  {
    slug: "sales-pages",
    href: "/reports/sales-pages",
    labelKey: "reportChannels",
    icon: Link01Icon,
  },
  {
    slug: "stock-movements",
    href: "/reports/stock-movements",
    labelKey: "reportStock",
    icon: WarehouseIcon,
  },
  {
    slug: "customer-debt",
    href: "/reports/customer-debt",
    labelKey: "reportCustomerDebt",
    icon: Contact01Icon,
  },
  {
    slug: "product-performance",
    href: "/reports/product-performance",
    labelKey: "reportProductPerformance",
    icon: Shirt01Icon,
  },
  {
    slug: "inventory-value",
    href: "/reports/inventory-value",
    labelKey: "reportInventoryValue",
    icon: Calculator01Icon,
  },
  {
    slug: "dead-stock",
    href: "/reports/dead-stock",
    labelKey: "reportDeadStock",
    icon: PackageReceive01Icon,
  },
  {
    slug: "reorder",
    href: "/reports/reorder",
    labelKey: "reportReorder",
    icon: ClipboardCheckIcon,
  },
];

export const reportNavItems = availableReports;
