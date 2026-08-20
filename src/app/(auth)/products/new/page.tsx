"use client";

import { Shirt01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";

import { api } from "@convex/_generated/api";
import { ProductForm } from "@/components/features/products/product-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { t } from "@/lib/utils";

// Create product. On save the server inserts the product AND one variant row
// per size (× color) with the default price/cost — the edit page then offers
// per-variant overrides and the bulk-apply tool.

export default function NewProductPage() {
  const router = useRouter();
  const user = useCurrentUser();
  const categories = useQuery(api.categories.listAll, user == null ? "skip" : {});

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Shirt01Icon} title={t().products.newTitle} />
      <div className="p-4">
        {categories === undefined ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <ProductForm categories={categories} onDone={() => router.push("/products")} />
        )}
      </div>
    </div>
  );
}
