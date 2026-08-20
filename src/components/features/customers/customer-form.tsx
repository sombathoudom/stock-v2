"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { FormInput } from "@/components/features/forms/form-input";
import { FormSwitch } from "@/components/features/forms/form-switch";
import { FormTextarea } from "@/components/features/forms/form-textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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

// One shared form for the create and edit customer pages. Dedupe (T7,
// AGENTS.md rule #6): while typing, an exact phone/name match is looked up
// and shown inline; on submit with matches present (or when the server
// rejects a duplicate phone), an alert dialog offers "Use existing" /
// "Create anyway". The server enforces phone uniqueness regardless.

const customerSchema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  phone: z.string().trim().max(30),
  address: z.string().max(300),
  notes: z.string().max(2000),
  active: z.boolean(),
});

type CustomerValues = z.infer<typeof customerSchema>;

/** Payload from the server's DUPLICATE_CUSTOMER error or a live lookup hit. */
type DuplicateInfo = {
  customerId: string;
  name: string;
  phone: string;
};

export function CustomerForm({
  customer,
  onDone,
}: {
  /** Present = edit mode; undefined = create mode. */
  customer?: Doc<"customers">;
  /** Called after save or cancel — the page navigates back to the list. */
  onDone: () => void;
}) {
  const router = useRouter();
  const user = useCurrentUser();
  const create = useMutation(api.customers.create);
  const update = useMutation(api.customers.update);
  const [saving, setSaving] = useState(false);
  // Alert dialog target — null = closed.
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);

  const form = useForm<CustomerValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      name: customer?.name ?? "",
      phone: customer?.phone ?? "",
      address: customer?.address ?? "",
      notes: customer?.notes ?? "",
      active: customer?.active ?? true,
    },
  });

  // Live dedupe lookup, debounced while typing.
  const watchedName = form.watch("name");
  const watchedPhone = form.watch("phone");
  const [lookupTerm, setLookupTerm] = useState({ name: "", phone: "" });
  useEffect(() => {
    const timer = setTimeout(
      () => setLookupTerm({ name: watchedName, phone: watchedPhone }),
      500
    );
    return () => clearTimeout(timer);
  }, [watchedName, watchedPhone]);

  const matches = useQuery(
    api.customers.lookup,
    user == null ||
      (!lookupTerm.name.trim() && !lookupTerm.phone.trim())
      ? "skip"
      : {
          name: lookupTerm.name.trim() || undefined,
          phone: lookupTerm.phone.trim() || undefined,
        },
  );

  // Exclude this customer in edit mode — its own phone is not a duplicate.
  const duplicates = (matches ?? []).filter((m) => m._id !== customer?._id);

  async function submit(values: CustomerValues, force: boolean) {
    setSaving(true);
    try {
      const payload = {
        name: values.name,
        phone: values.phone.trim() || undefined,
        address: values.address.trim() || undefined,
        notes: values.notes.trim() || undefined,
      };
      if (customer) {
        await update({
          customerId: customer._id,
          ...payload,
          active: values.active,
          forceCreate: force,
        });
        toast.success(t().customers.saved);
      } else {
        await create({ ...payload, forceCreate: force });
        toast.success(t().customers.created);
      }
      onDone();
    } catch (err) {
      const duplicateInfo = duplicateInfoOf(err);
      if (duplicateInfo) {
        // Server rejected the phone — same "already exists" prompt.
        setDuplicate(duplicateInfo);
      } else {
        toastError(err);
      }
    } finally {
      setSaving(false);
    }
  }

  function onSubmit(values: CustomerValues, force = false) {
    // A live lookup found a match and the owner hasn't chosen yet: ask first
    // ("pick existing or force-create" — the server enforces anyway).
    if (!force && duplicates.length > 0) {
      const first = duplicates[0];
      setDuplicate({
        customerId: first._id,
        name: first.name,
        phone: first.phone,
      });
      return;
    }
    void submit(values, force);
  }

  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit((values) => onSubmit(values))}>
        <Card>
          <CardHeader>
            <CardTitle>
              {customer ? t().customers.editTitle : t().customers.newTitle}
            </CardTitle>
            <CardDescription>{t().customers.nameHint}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <FormInput
              name="name"
              label={t().common.name}
              required
              maxLength={100}
              placeholder={t().customers.nameHint}
            />
            <FormInput
              name="phone"
              label={t().customers.phone}
              hint={t().customers.phoneHint}
              maxLength={30}
              inputMode="tel"
              placeholder="012 345 678"
            />
            <FormTextarea
              name="address"
              label={t().customers.address}
              hint={t().customers.addressHint}
              rows={3}
              placeholder={t().customers.addressHint}
            />
            <FormTextarea
              name="notes"
              label={t().customers.notes}
              hint={t().customers.notesHint}
              placeholder={t().customers.notesHint}
            />
            {/* Deactivating is owner-only — staff see no switch (the form
                keeps the record's current value, so saves still work). */}
            {(user == null || user.role === "owner") && (
              <FormSwitch
                name="active"
                label={t().common.active}
                hint={t().customers.activeHint}
              />
            )}
            {duplicates.length > 0 && (
              <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                <p className="text-sm font-medium">
                  {t().customers.duplicateTitle}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t().customers.duplicateBody}
                </p>
                {duplicates.map((d) => (
                  <div
                    key={d._id}
                    className="flex flex-wrap items-center gap-2"
                  >
                    <span className="text-sm">
                      {d.name}
                      {d.phone ? ` (${d.phone})` : ""}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        router.push(`/customers/${d._id as Id<"customers">}`)
                      }
                    >
                      {t().customers.useExisting}
                    </Button>
                  </div>
                ))}
              </div>
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

      {/* The "already exists" prompt: pick the existing record or create anyway. */}
      <AlertDialog
        open={duplicate !== null}
        onOpenChange={(open) => {
          if (!open) setDuplicate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t().customers.duplicateTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="flex flex-col gap-1">
                <span>{t().customers.duplicateBody}</span>
                {duplicate && (
                  <Badge variant="secondary" className="w-fit gap-1">
                    {duplicate.name}
                    {duplicate.phone ? ` · ${duplicate.phone}` : ""}
                  </Badge>
                )}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
              {t().common.cancel}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (duplicate) {
                  router.push(`/customers/${duplicate.customerId as Id<"customers">}`);
                }
              }}
            >
              {t().customers.useExisting}
            </AlertDialogAction>
            <Button
              type="button"
              onClick={() => {
                setDuplicate(null);
                // Explicit force=true — state updates are async, so passing
                // it through handleSubmit avoids a stale-closure resubmit.
                void form.handleSubmit((values) => onSubmit(values, true))();
              }}
            >
              {t().customers.createAnyway}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FormProvider>
  );
}

/** Extract the duplicate payload from a DUPLICATE_CUSTOMER ConvexError. */
function duplicateInfoOf(err: unknown): DuplicateInfo | null {
  if (
    err instanceof Error &&
    "data" in err &&
    typeof (err as { data?: unknown }).data === "object" &&
    (err as { data: { code?: string } }).data?.code === "DUPLICATE_CUSTOMER"
  ) {
    const d = (err as { data: { customerId?: string; customerName?: string; customerPhone?: string } })
      .data;
    if (d.customerId) {
      return {
        customerId: d.customerId,
        name: d.customerName ?? "",
        phone: d.customerPhone ?? "",
      };
    }
  }
  return null;
}
