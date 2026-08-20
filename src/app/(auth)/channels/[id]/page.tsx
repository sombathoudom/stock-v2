"use client";

import { Link01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { use } from "react";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { ChannelForm } from "@/components/features/channels/channel-form";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { QueryErrorBoundary } from "@/components/features/shell/query-error-boundary";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isConvexId, t } from "@/lib/utils";

// T8 — Edit sales page (AGENTS.md). The id in the URL is the Convex UUID —
// never an enumerable number.

export default function EditChannelPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Link01Icon} title={t().channels.editTitle} />
      <div className="p-4">
        {/* key={id} remounts a fresh boundary when navigating between ids */}
        <QueryErrorBoundary
          key={id}
          fallbackTitle={t().channels.notFoundTitle}
          fallbackBody={t().channels.notFoundBody}
        >
          <ChannelLoader id={id} />
        </QueryErrorBoundary>
      </div>
    </div>
  );
}

// The query-driven part — it must live BELOW the boundary so a render-phase
// throw (a checksum-invalid id the client can't verify) is caught here.
function ChannelLoader({ id }: { id: string }) {
  const router = useRouter();
  const user = useCurrentUser();
  // Fast-path check for obviously malformed ids — avoids firing a doomed
  // request; the boundary above catches anything this misses.
  const validId = isConvexId(id);
  const channel = useQuery(
    api.channels.get,
    user == null || !validId ? "skip" : { channelId: id as Id<"salesChannels"> },
  );

  if (!validId || channel === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t().channels.notFoundTitle}</CardTitle>
          <CardDescription>{t().channels.notFoundBody}</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (channel === undefined) {
    return <Skeleton className="h-64 w-full" />;
  }
  return (
    <ChannelForm channel={channel} onDone={() => router.push("/channels")} />
  );
}
