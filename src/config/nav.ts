// All navigation in ONE place: links, labels (via labels.ts keys), icons,
// roles, and the phase each page ships in. The app shell renders from this —
// adding a page never means editing nav JSX.

import {
  Analytics01Icon,
  BoxIcon,
  Calculator01Icon,
  ClipboardCheckIcon,
  ClipboardIcon,
  Contact01Icon,
  DashboardSquare01Icon,
  DeliveryTruck01Icon,
  FileUploadIcon,
  Link01Icon,
  PackageReceive01Icon,
  Settings01Icon,
  Shirt01Icon,
  ShoppingBag01Icon,
  TagsIcon,
  UserGroupIcon,
  WarehouseIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

export type NavItem = {
  /** Key into labels[lang].nav — the display name. */
  labelKey:
    | "dashboard"
    | "sales"
    | "products"
    | "categories"
    | "customers"
    | "stock"
    | "adjustments"
    | "purchases"
    | "suppliers"
    | "delivery"
    | "deliveryReport"
    | "channels"
    | "expenses"
    | "reports"
    | "settings"
    | "countStock"
    | "importProducts"
    | "openingStock"
    | "more";
  href: string;
  /** hugeicons icon data object — rendered through HugeiconsIcon. */
  icon: IconSvgElement;
  /** Roles that can see the item. Undefined = everyone signed in. */
  roles?: ("owner" | "staff")[];
  /** Roadmap phase the page ships in; items with phase > CURRENT_PHASE are hidden. */
  phase: number;
  /** Show in the mobile bottom nav (max 5–7 items). */
  inBottomNav?: boolean;
  /** Only shown when the shop has the delivery module on (checked in the shell). */
  requiresDelivery?: boolean;
  /** Optional sub-items rendered as an expandable group in the sidebar. */
  children?: NavItem[];
};

/**
 * Bump this as phases land. The shell automatically shows the new pages.
 * 1 = foundation & catalog, 2 = stock, 3 = sales, 4 = delivery,
 * 5 = reports/expenses, 6 = extras (adjustments/stocktake, printing, roles, credit).
 */
export const CURRENT_PHASE = 6;

export const navItems: NavItem[] = [
  {
    labelKey: "dashboard",
    href: "/dashboard",
    icon: DashboardSquare01Icon,
    phase: 1,
    inBottomNav: true,
  },
  {
    labelKey: "sales",
    href: "/sales",
    icon: ShoppingBag01Icon,
    phase: 3,
    inBottomNav: true,
  },
  {
    labelKey: "products",
    href: "/products",
    icon: Shirt01Icon,
    phase: 1,
    inBottomNav: true,
    children: [
      {
        labelKey: "countStock",
        href: "/products/count-stock",
        icon: ClipboardIcon,
        phase: 1,
      },
      {
        labelKey: "importProducts",
        href: "/products/import",
        icon: FileUploadIcon,
        phase: 1,
      },
      {
        labelKey: "openingStock",
        href: "/products/opening-stock",
        icon: WarehouseIcon,
        phase: 1,
      },
    ],
  },
  {
    labelKey: "categories",
    href: "/categories",
    icon: TagsIcon,
    phase: 1,
  },
  {
    labelKey: "stock",
    href: "/stock",
    icon: WarehouseIcon,
    phase: 2,
    inBottomNav: true,
  },
  {
    labelKey: "adjustments",
    href: "/adjustments",
    icon: ClipboardCheckIcon,
    phase: 6,
  },
  {
    labelKey: "purchases",
    href: "/purchases",
    icon: BoxIcon,
    phase: 2,
  },
  {
    labelKey: "suppliers",
    href: "/suppliers",
    icon: Contact01Icon,
    phase: 2,
  },
  {
    labelKey: "customers",
    href: "/customers",
    icon: UserGroupIcon,
    phase: 3,
  },
  {
    labelKey: "channels",
    href: "/channels",
    icon: Link01Icon,
    phase: 3,
  },
  {
    labelKey: "delivery",
    href: "/delivery-companies",
    icon: DeliveryTruck01Icon,
    phase: 3,
  },
  {
    labelKey: "deliveryReport",
    href: "/delivery",
    icon: PackageReceive01Icon,
    phase: 4,
    requiresDelivery: true,
  },
  {
    labelKey: "expenses",
    href: "/expenses",
    icon: Calculator01Icon,
    phase: 5,
  },
  {
    labelKey: "reports",
    href: "/reports",
    icon: Analytics01Icon,
    phase: 5,
    inBottomNav: true,
  },
  {
    labelKey: "settings",
    href: "/settings",
    icon: Settings01Icon,
    roles: ["owner"],
    phase: 1,
  },
];

export const visibleNavItems = navItems
  .filter((item) => item.phase <= CURRENT_PHASE)
  .map((item) => ({
    ...item,
    children: item.children?.filter((child) => child.phase <= CURRENT_PHASE),
  }));
