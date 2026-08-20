"use client";

import { Shirt01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { ProductForm } from "@/components/features/products/product-form";
import { VariantGrid } from "@/components/features/products/variant-grid";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isConvexId, t } from "@/lib/utils";

// Edit page: the product form on top, the variant grid (overrides + bulk
// apply) underneath. The id in the URL is the Convex UUID — never an
// enumerable number.

export default function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Shirt01Icon} title={t().products.editTitle} />
      <div className="flex flex-col gap-4 p-4">
        {/* key={id} remounts a fresh boundary when navigating between ids */}
        <QueryErrorBoundary
          key={id}
          fallbackTitle={t().products.notFoundTitle}
          fallbackBody={t().products.notFoundBody}
        >
          <ProductLoader id={id} />
        </QueryErrorBoundary>
      </div>
    </div>
  );
}

// The query-driven part — it must live BELOW the boundary so a render-phase
// throw (a checksum-invalid id the client can't verify) is caught here.
function ProductLoader({ id }: { id: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  // Fast-path check for obviously malformed ids — avoids firing a doomed
  // request; the boundary above catches anything this misses.
  const validId = isConvexId(id);
  const product = useQuery(
    api.products.get,
    user == null || !validId ? "skip" : { productId: id as Id<"products"> },
  );
  const variants = useQuery(
    api.products.listVariants,
    user == null || !validId || product == null
      ? "skip"
      : { productId: id as Id<"products"> },
  );
  const categories = useQuery(api.categories.listAll, user == null ? "skip" : {});

  if (!validId || product === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().products.notFoundTitle}</CardTitle>
          <CardDescription>{t().products.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (product === undefined || variants === undefined || categories === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }
  return (
    <>
      <ProductForm
        product={product}
        categories={categories}
        onDone={() => router.push("/products")}
      />
      <VariantGrid product={product} variants={variants} />
    </>
  );
}
