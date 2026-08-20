"use client";

import { DeliveryTruck01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { DeliveryCompanyForm } from "@/components/features/delivery/delivery-company-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isConvexId, t } from "@/lib/utils";

// T9 — Edit delivery company (AGENTS.md). The id in the URL is the Convex
// UUID — never an enumerable number.

export default function EditDeliveryCompanyPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={DeliveryTruck01Icon} title={t().deliveryCompanies.editTitle} />
      <div className="p-4">
        {/* key={id} remounts a fresh boundary when navigating between ids */}
        <QueryErrorBoundary
          key={id}
          fallbackTitle={t().deliveryCompanies.notFoundTitle}
          fallbackBody={t().deliveryCompanies.notFoundBody}
        >
          <CompanyLoader id={id} />
        </QueryErrorBoundary>
      </div>
    </div>
  );
}

// The query-driven part — it must live BELOW the boundary so a render-phase
// throw (a checksum-invalid id the client can't verify) is caught here.
function CompanyLoader({ id }: { id: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  // Fast-path check for obviously malformed ids — avoids firing a doomed
  // request; the boundary above catches anything this misses.
  const validId = isConvexId(id);
  const company = useQuery(
    api.deliveryCompanies.get,
    user == null || !validId ? "skip" : { companyId: id as Id<"deliveryCompanies"> },
  );

  if (!validId || company === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().deliveryCompanies.notFoundTitle}</CardTitle>
          <CardDescription>{t().deliveryCompanies.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (company === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }
  return (
    <DeliveryCompanyForm
      company={company}
      onDone={() => router.push("/delivery-companies")}
    />
  );
}
