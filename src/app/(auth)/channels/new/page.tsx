"use client";

import { Link01Icon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";

import { ChannelForm } from "@/components/features/channels/channel-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { t } from "@/lib/utils";

// T8 — New sales page (AGENTS.md).

export default function NewChannelPage() {
  const router = useRouter();

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Link01Icon} title={t().channels.newTitle} />
      <div className="p-4">
        <ChannelForm onDone={() => router.push("/channels")} />
      </div>
    </div>
  );
}
