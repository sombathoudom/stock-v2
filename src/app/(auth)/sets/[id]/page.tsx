"use client";

import { Package01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { SetForm } from "@/components/features/sets/set-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isConvexId, t } from "@/lib/utils";

export default function EditSetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Package01Icon} title={t().sets.editTitle} />
      <div className="p-4">
        <QueryErrorBoundary
          key={id}
          fallbackTitle={t().sets.notFoundTitle}
          fallbackBody={t().sets.notFoundBody}
        >
          <SetLoader id={id} />
        </QueryErrorBoundary>
      </div>
    </div>
  );
}

function SetLoader({ id }: { id: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  const validId = isConvexId(id);
  const detail = useQuery(
    api.sets.get,
    user == null || !validId ? "skip" : { setId: id as Id<"sets"> },
  );

  if (!validId || detail === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().sets.notFoundTitle}</CardTitle>
          <CardDescription>{t().sets.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (detail === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }
  return <SetForm detail={detail} onDone={() => router.push("/sets")} />;
}
