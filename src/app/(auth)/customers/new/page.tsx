"use client";

import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";

import { CustomerForm } from "@/components/features/customers/customer-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { t } from "@/lib/utils";

// T7 — New customer (AGENTS.md). The form does the phone/name dedupe lookup
// and offers "Use existing / Create anyway" when a match is found.

export default function NewCustomerPage() {
  const router = useRouter();

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={UserGroupIcon} title={t().customers.newTitle} />
      <div className="p-4">
        <CustomerForm onDone={() => router.push("/customers")} />
      </div>
    </div>
  );
}
