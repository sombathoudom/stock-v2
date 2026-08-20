"use client";

import { TagsIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { CategoryForm } from "@/components/features/categories/category-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isConvexId, t } from "@/lib/utils";

// Edit page. The id in the URL is the Convex UUID — never an enumerable
// number — and the server only returns the category that id points at.

export default function EditCategoryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={TagsIcon} title={t().categories.editTitle} />
      <div className="p-4">
        {/* key={id} remounts a fresh boundary when navigating between ids */}
        <QueryErrorBoundary
          key={id}
          fallbackTitle={t().categories.notFoundTitle}
          fallbackBody={t().categories.notFoundBody}
        >
          <CategoryLoader id={id} />
        </QueryErrorBoundary>
      </div>
    </div>
  );
}

// The query-driven part — it must live BELOW the boundary so a render-phase
// throw (a checksum-invalid id the client can't verify) is caught here.
function CategoryLoader({ id }: { id: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  // Fast-path check for obviously malformed ids — avoids firing a doomed
  // request; the boundary above catches anything this misses.
  const validId = isConvexId(id);
  const category = useQuery(
    api.categories.get,
    user == null || !validId ? "skip" : { categoryId: id as Id<"categories"> },
  );

  if (!validId || category === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().categories.notFoundTitle}</CardTitle>
          <CardDescription>{t().categories.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (category === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }
  return <CategoryForm category={category} onDone={() => router.push("/categories")} />;
}
