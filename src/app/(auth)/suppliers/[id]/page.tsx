"use client";

import { Contact01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import { SupplierForm } from "@/components/features/suppliers/supplier-form";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isConvexId, t } from "@/lib/utils";

// Edit page. The id in the URL is the Convex UUID — never an enumerable
// number — and the server only returns the supplier that id points at.

export default function EditSupplierPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Contact01Icon} title={t().suppliers.editTitle} />
      <div className="p-4">
        {/* key={id} remounts a fresh boundary when navigating between ids */}
        <QueryErrorBoundary
          key={id}
          fallbackTitle={t().suppliers.notFoundTitle}
          fallbackBody={t().suppliers.notFoundBody}
        >
          <SupplierLoader id={id} />
        </QueryErrorBoundary>
      </div>
    </div>
  );
}

// The query-driven part — it must live BELOW the boundary so a render-phase
// throw (a checksum-invalid id the client can't verify) is caught here.
function SupplierLoader({ id }: { id: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  // Fast-path check for obviously malformed ids — avoids firing a doomed
  // request; the boundary above catches anything this misses.
  const validId = isConvexId(id);
  const supplier = useQuery(
    api.suppliers.get,
    user == null || !validId ? "skip" : { supplierId: id as Id<"suppliers"> },
  );

  if (!validId || supplier === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().suppliers.notFoundTitle}</CardTitle>
          <CardDescription>{t().suppliers.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (supplier === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }
  return <SupplierForm supplier={supplier} onDone={() => router.push("/suppliers")} />;
}
