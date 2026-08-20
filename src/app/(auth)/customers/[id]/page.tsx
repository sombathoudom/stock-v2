"use client";

import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { CustomerForm } from "@/components/features/customers/customer-form";
import { CustomerLedger } from "@/components/features/customers/customer-ledger";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isConvexId, t } from "@/lib/utils";

// T7 — Edit customer (AGENTS.md). The id in the URL is the Convex UUID —
// never an enumerable number, so no one can guess another customer's record.

export default function EditCustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={UserGroupIcon} title={t().customers.editTitle} />
      <div className="p-4">
        {/* key={id} remounts a fresh boundary when navigating between ids */}
        <QueryErrorBoundary
          key={id}
          fallbackTitle={t().customers.notFoundTitle}
          fallbackBody={t().customers.notFoundBody}
        >
          <CustomerLoader id={id} />
        </QueryErrorBoundary>
      </div>
    </div>
  );
}

// The query-driven part — it must live BELOW the boundary so a render-phase
// throw (a checksum-invalid id the client can't verify) is caught here.
function CustomerLoader({ id }: { id: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  // Fast-path check for obviously malformed ids — avoids firing a doomed
  // request; the boundary above catches anything this misses.
  const validId = isConvexId(id);
  const customer = useQuery(
    api.customers.get,
    user == null || !validId ? "skip" : { customerId: id as Id<"customers"> },
  );
  const shop = useQuery(api.shop.get, user == null ? "skip" : {});

  if (!validId || customer === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().customers.notFoundTitle}</CardTitle>
          <CardDescription>{t().customers.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (customer === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }
  return (
    <div className="flex flex-col gap-4">
      <CustomerForm
        customer={customer}
        onDone={() => router.push("/customers")}
      />
      {/* T27 — the credit ledger sits under the form: what this customer
          still owes, order by order, with one-tap reminders. */}
      <CustomerLedger
        customer={customer}
        currency={shop?.currency ?? "USD"}
      />
    </div>
  );
}
