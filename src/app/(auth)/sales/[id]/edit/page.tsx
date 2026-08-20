"use client";

import { PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { SaleEditForm } from "@/components/features/sales/sale-edit-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isConvexId, t } from "@/lib/utils";

// T12 — the full-page order editor. The id in the URL is the Convex UUID —
// never an enumerable number — and the server only returns the order that id
// points at.

export default function EditSalePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={PencilEdit01Icon} title={t().sales.edit.title} />
      <div className="p-4">
        {/* key={id} remounts a fresh boundary when navigating between ids */}
        <QueryErrorBoundary
          key={id}
          fallbackTitle={t().sales.notFoundTitle}
          fallbackBody={t().sales.notFoundBody}
        >
          <SaleEditLoader id={id} />
        </QueryErrorBoundary>
      </div>
    </div>
  );
}

// The query-driven part — it must live BELOW the boundary so a render-phase
// throw (a checksum-invalid id the client can't verify) is caught there.
function SaleEditLoader({ id }: { id: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  // Fast-path check for obviously malformed ids — avoids firing a doomed
  // request; the boundary above catches anything this misses.
  const validId = isConvexId(id);
  const data = useQuery(
    api.sales.getEditData,
    user == null || !validId ? "skip" : { saleId: id as Id<"sales"> }
  );

  if (!validId || data === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().sales.notFoundTitle}</CardTitle>
          <CardDescription>{t().sales.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (data === undefined) {
    return <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="flex flex-col gap-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href="/sales" />}>
              {t().sales.edit.breadcrumb}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link href={`/sales/${id}`} />}>
              {data.sale.code}
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{t().sales.edit.breadcrumbEdit}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      {/* Saving and cancelling both land back on the order they edited. */}
      <SaleEditForm data={data} onDone={() => router.push(`/sales/${id}`)} />
    </div>
  );
}
