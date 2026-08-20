"use client";

import { Calculator01Icon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";

import { ExpenseForm } from "@/components/features/expenses/expense-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { t } from "@/lib/utils";

// Create expense.

export default function NewExpensePage() {
  const router = useRouter();

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Calculator01Icon} title={t().expenses.newTitle} />
      <div className="p-4">
        <ExpenseForm onDone={() => router.push("/expenses")} />
      </div>
    </div>
  );
}
