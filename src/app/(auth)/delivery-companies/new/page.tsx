"use client";

import { DeliveryTruck01Icon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";

import { DeliveryCompanyForm } from "@/components/features/delivery/delivery-company-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { t } from "@/lib/utils";

// T9 — New delivery company (AGENTS.md).

export default function NewDeliveryCompanyPage() {
  const router = useRouter();

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={DeliveryTruck01Icon} title={t().deliveryCompanies.newTitle} />
      <div className="p-4">
        <DeliveryCompanyForm onDone={() => router.push("/delivery-companies")} />
      </div>
    </div>
  );
}
