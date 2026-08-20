"use client";

import { TagsIcon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";

import { CategoryForm } from "@/components/features/categories/category-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { t } from "@/lib/utils";

// Create page — the shared CategoryForm owns the mutation and toasts.
export default function NewCategoryPage() {
  const router = useRouter();

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={TagsIcon} title={t().categories.newTitle} />
      <div className="p-4">
        <CategoryForm onDone={() => router.push("/categories")} />
      </div>
    </div>
  );
}
