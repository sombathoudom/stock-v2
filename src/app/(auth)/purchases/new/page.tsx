"use client";

import { BoxIcon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";

import { PurchaseForm } from "@/components/features/purchases/purchase-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { t } from "@/lib/utils";

// New purchase — draft until the goods arrive (receive writes the ledger).

export default function NewPurchasePage() {
  const router = useRouter();

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={BoxIcon} title={t().purchases.newTitle} />
      <div className="p-4">
        <PurchaseForm onDone={() => router.push("/purchases")} />
      </div>
    </div>
  );
}
