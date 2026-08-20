"use client";

import { Contact01Icon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";

import { SupplierForm } from "@/components/features/suppliers/supplier-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { t } from "@/lib/utils";

// Create supplier.

export default function NewSupplierPage() {
  const router = useRouter();

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Contact01Icon} title={t().suppliers.newTitle} />
      <div className="p-4">
        <SupplierForm onDone={() => router.push("/suppliers")} />
      </div>
    </div>
  );
}
