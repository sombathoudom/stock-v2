import type { ReactNode } from "react";

// Each report is a full-width page. Navigation between reports lives in the
// main app sidebar's "Reports" submenu (see src/config/nav.ts) — this layout
// no longer renders a secondary in-page report menu.
export default function ReportsLayout({ children }: { children: ReactNode }) {
  return <div className="min-w-0 flex-1">{children}</div>;
}
