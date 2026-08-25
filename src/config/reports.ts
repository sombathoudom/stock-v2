import {
  Analytics01Icon,
  BoxIcon,
  Calculator01Icon,
  ClipboardCheckIcon,
  Contact01Icon,
  DeliveryTruck01Icon,
  Link01Icon,
  PackageReceive01Icon,
  Shirt01Icon,
  ShoppingBag01Icon,
  UserGroupIcon,
  WarehouseIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";

export type ReportLabelKey =
  | "reportPl"
  | "reportChannels"
  | "reportStock"
  | "reportCustomerDebt"
  | "reportProductPerformance"
  | "reportInventoryValue"
  | "reportDeadStock"
  | "reportReorder"
  | "reportPurchasesSuppliers"
  | "reportCashPayments"
  | "reportExpenseTrends"
  | "reportDeliveryPerformance"
  | "reportStaffPerformance"
  | "reportReturnsExchanges"
  | "reportCustomerValue";

export type ReportDescriptionKey =
  | "customerDebtDescription"
  | "productPerformanceDescription"
  | "inventoryValueDescription"
  | "deadStockDescription"
  | "reorderDescription"
  | "purchasesSuppliersDescription"
  | "cashPaymentsDescription"
  | "expenseTrendsDescription"
  | "deliveryPerformanceDescription"
  | "staffPerformanceDescription"
  | "returnsExchangesDescription"
  | "customerValueDescription";

export type ReportNavItem = {
  slug: string;
  href: string;
  labelKey: ReportLabelKey;
  icon: IconSvgElement;
  status: "available" | "comingSoon";
  descriptionKey?: ReportDescriptionKey;
};

export const availableReports: ReportNavItem[] = [
  {
    slug: "profit-loss",
    href: "/reports/profit-loss",
    labelKey: "reportPl",
    icon: Analytics01Icon,
    status: "available",
  },
  {
    slug: "sales-pages",
    href: "/reports/sales-pages",
    labelKey: "reportChannels",
    icon: Link01Icon,
    status: "available",
  },
  {
    slug: "stock-movements",
    href: "/reports/stock-movements",
    labelKey: "reportStock",
    icon: WarehouseIcon,
    status: "available",
  },
  {
    slug: "customer-debt",
    href: "/reports/customer-debt",
    labelKey: "reportCustomerDebt",
    icon: Contact01Icon,
    status: "available",
  },
  {
    slug: "product-performance",
    href: "/reports/product-performance",
    labelKey: "reportProductPerformance",
    icon: Shirt01Icon,
    status: "available",
  },
  {
    slug: "inventory-value",
    href: "/reports/inventory-value",
    labelKey: "reportInventoryValue",
    icon: Calculator01Icon,
    status: "available",
  },
  {
    slug: "dead-stock",
    href: "/reports/dead-stock",
    labelKey: "reportDeadStock",
    icon: PackageReceive01Icon,
    status: "available",
  },
  {
    slug: "reorder",
    href: "/reports/reorder",
    labelKey: "reportReorder",
    icon: ClipboardCheckIcon,
    status: "available",
  },
];

export const recommendedReports: ReportNavItem[] = [
  {
    slug: "purchases-suppliers",
    href: "/reports/purchases-suppliers",
    labelKey: "reportPurchasesSuppliers",
    descriptionKey: "purchasesSuppliersDescription",
    icon: BoxIcon,
    status: "comingSoon",
  },
  {
    slug: "cash-payments",
    href: "/reports/cash-payments",
    labelKey: "reportCashPayments",
    descriptionKey: "cashPaymentsDescription",
    icon: Calculator01Icon,
    status: "comingSoon",
  },
  {
    slug: "expense-trends",
    href: "/reports/expense-trends",
    labelKey: "reportExpenseTrends",
    descriptionKey: "expenseTrendsDescription",
    icon: Analytics01Icon,
    status: "comingSoon",
  },
  {
    slug: "delivery-performance",
    href: "/reports/delivery-performance",
    labelKey: "reportDeliveryPerformance",
    descriptionKey: "deliveryPerformanceDescription",
    icon: DeliveryTruck01Icon,
    status: "comingSoon",
  },
  {
    slug: "staff-performance",
    href: "/reports/staff-performance",
    labelKey: "reportStaffPerformance",
    descriptionKey: "staffPerformanceDescription",
    icon: UserGroupIcon,
    status: "comingSoon",
  },
  {
    slug: "returns-exchanges",
    href: "/reports/returns-exchanges",
    labelKey: "reportReturnsExchanges",
    descriptionKey: "returnsExchangesDescription",
    icon: ClipboardCheckIcon,
    status: "comingSoon",
  },
  {
    slug: "customer-value",
    href: "/reports/customer-value",
    labelKey: "reportCustomerValue",
    descriptionKey: "customerValueDescription",
    icon: ShoppingBag01Icon,
    status: "comingSoon",
  },
];

export const reportNavItems = [...availableReports, ...recommendedReports];
