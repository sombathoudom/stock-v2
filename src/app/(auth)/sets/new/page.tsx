"use client";

import { Package01Icon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";

import { SetForm } from "@/components/features/sets/set-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { t } from "@/lib/utils";

export default function NewSetPage() {
  const router = useRouter();

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Package01Icon} title={t().sets.newTitle} />
      <div className="p-4">
        <SetForm onDone={() => router.push("/sets")} />
      </div>
    </div>
  );
}
