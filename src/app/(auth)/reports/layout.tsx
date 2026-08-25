import type { ReactNode } from "react";

import { ReportSubnav } from "@/components/features/reports/report-subnav";

export default function ReportsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
      <ReportSubnav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
