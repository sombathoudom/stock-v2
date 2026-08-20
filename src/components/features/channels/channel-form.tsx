"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "convex/react";
import { useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
import { FormInput } from "@/components/features/forms/form-input";
import { FormSelect } from "@/components/features/forms/form-select";
import { FormSwitch } from "@/components/features/forms/form-switch";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCurrentUser } from "@/hooks/use-current-user";
import { t, toastError } from "@/lib/utils";

// One shared form for the create and edit sales-page pages (T8). The server
// re-validates everything (convex/channels.ts) — this is UX validation.

const channelSchema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  type: z.enum(["facebook", "instagram", "tiktok", "walk_in", "custom"]),
  active: z.boolean(),
});

type ChannelValues = z.infer<typeof channelSchema>;

const CHANNEL_TYPES = ["facebook", "instagram", "tiktok", "walk_in", "custom"] as const;

export function ChannelForm({
  channel,
  onDone,
}: {
  /** Present = edit mode; undefined = create mode. */
  channel?: Doc<"salesChannels">;
  /** Called after save or cancel — the page navigates back to the list. */
  onDone: () => void;
}) {
  const create = useMutation(api.channels.create);
  const update = useMutation(api.channels.update);
  const [saving, setSaving] = useState(false);
  const user = useCurrentUser();

  const form = useForm<ChannelValues>({
    resolver: zodResolver(channelSchema),
    defaultValues: {
      name: channel?.name ?? "",
      type: channel?.type ?? "facebook",
      active: channel?.active ?? true,
    },
  });

  const typeOptions = CHANNEL_TYPES.map((key) => ({
    value: key,
    label: t().channels.types[key],
  }));

  async function onSubmit(values: ChannelValues) {
    setSaving(true);
    try {
      const payload = { name: values.name, type: values.type };
      if (channel) {
        await update({ channelId: channel._id, ...payload, active: values.active });
        toast.success(t().channels.saved);
      } else {
        await create(payload);
        toast.success(t().channels.created);
      }
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <Card>
          <CardHeader>
            <CardTitle>
              {channel ? t().channels.editTitle : t().channels.newTitle}
            </CardTitle>
            <CardDescription>{t().channels.nameHint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormInput
              name="name"
              label={t().common.name}
              required
              maxLength={100}
              placeholder={t().channels.nameHint}
            />
            <FormSelect
              name="type"
              label={t().channels.type}
              hint={t().channels.typeHint}
              options={typeOptions}
            />
            {/* Deactivating is owner-only — staff see no switch (the form
                keeps the record's current value, so saves still work). */}
            {(user == null || user.role === "owner") && (
              <FormSwitch
                name="active"
                label={t().common.active}
                hint={t().channels.activeHint}
              />
            )}
          </CardContent>
          <CardFooter className="border-t">
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={saving}>
                {t().common.save}
              </Button>
              <Button type="button" variant="destructive" onClick={onDone}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
                {t().common.cancel}
              </Button>
            </div>
          </CardFooter>
        </Card>
      </form>
    </FormProvider>
  );
}
