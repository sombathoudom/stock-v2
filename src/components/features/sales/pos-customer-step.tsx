"use client";

import { Cancel01Icon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
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
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/use-current-user";
import { t, toastError } from "@/lib/utils";

// T10 — POS customer step (AGENTS.md, checkout step ②). The combobox search
// is SERVER-side (api.customers.listActive, name/phone prefix, debounced).
// The New-customer dialog reuses the T7 dedupe flow: a DUPLICATE_CUSTOMER
// rejection offers "Use existing" (selects the found customer) or "Create
// anyway" (retry with forceCreate). The server enforces phone uniqueness
// regardless — the prompt here is UX for choosing which record to use.

type DuplicateInfo = { customerId: string; name: string; phone: string };

export function PosCustomerStep({
  customerId,
  onSelect,
}: {
  customerId: string | null;
  onSelect: (customer: Doc<"customers">) => void;
}) {
  const user = useCurrentUser();

  // Search term + debounced copy that drives the server query.
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const customers = useQuery(
    api.customers.listActive,
    user == null ? "skip" : { search: debouncedQuery.trim() || undefined }
  );

  const labelById = useMemo(
    () =>
      new Map<string, string>(
        (customers ?? []).map((c) => [
          c._id,
          `${c.name}${c.phone ? ` · ${c.phone}` : ""}`,
        ])
      ),
    [customers]
  );

  // --- New-customer dialog ---
  const [newOpen, setNewOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [creating, setCreating] = useState(false);
  const create = useMutation(api.customers.create);

  // --- Duplicate alert: resolve the existing row so "Use existing" can
  // hand a full Doc back to the page. ---
  const [dupId, setDupId] = useState<string | null>(null);
  const dupCustomer = useQuery(
    api.customers.get,
    user == null || dupId === null
      ? "skip"
      : { customerId: dupId as Id<"customers"> }
  );

  async function doCreate(force: boolean) {
    setCreating(true);
    try {
      const created = await create({
        name,
        phone: phone.trim() || undefined,
        address: address.trim() || undefined,
        forceCreate: force || undefined,
      });
      toast.success(t().customers.created);
      setNewOpen(false);
      setName("");
      setPhone("");
      setAddress("");
      onSelect(created);
    } catch (err) {
      const info = duplicateInfoOf(err);
      if (info) setDupId(info.customerId);
      else toastError(err);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <div className="flex w-full items-center gap-2">
        <div className="min-w-0 flex-1">
          <Combobox
            items={(customers ?? []).map((c) => c._id)}
            itemToStringLabel={(item) => {
              if (item == null) return "";
              const value =
                typeof item === "object" && "value" in item
                  ? String((item as { value: unknown }).value)
                  : String(item);
              return labelById.get(value) ?? value;
            }}
            value={customerId}
            onValueChange={(value) => {
              const found = (customers ?? []).find((c) => c._id === value);
              if (found) onSelect(found);
            }}
            // Only user typing drives the server search — Base UI's programmatic
            // fills (selection sync) arrive with a different reason.
            onInputValueChange={(inputValue, eventDetails) => {
              if (eventDetails?.reason === "input-change") setQuery(inputValue);
            }}
          >
            <ComboboxInput
              placeholder={t().sales.searchCustomers}
              showClear
              // Select the current value on focus so typing replaces it.
              onFocus={(e) => (e.target as HTMLInputElement).select()}
            />
            <ComboboxContent>
              <ComboboxEmpty>{t().sales.noCustomers}</ComboboxEmpty>
              <ComboboxList>
                {(customers ?? []).map((c) => (
                  <ComboboxItem key={c._id} value={c._id}>
                    <span className="truncate">{c.name}</span>
                    {c.phone ? (
                      <span className="text-xs text-muted-foreground">
                        · {c.phone}
                      </span>
                    ) : null}
                  </ComboboxItem>
                ))}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
        </div>
        {/* Always INLINE beside the selector — icon-only on phone (44px
            tap target), icon + text from sm up. */}
        <Button
          type="button"
          variant="outline"
          className="size-11 shrink-0 px-0 sm:h-9 sm:w-auto sm:px-3"
          onClick={() => setNewOpen(true)}
          aria-label={t().sales.newCustomer}
        >
          <HugeiconsIcon icon={UserAdd01Icon} strokeWidth={2} className="size-4" />
          <span className="hidden sm:inline">{t().sales.newCustomer}</span>
        </Button>
      </div>

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t().sales.newCustomer}</DialogTitle>
            <DialogDescription>{t().customers.nameHint}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="pos-new-customer-name">{t().common.name}</Label>
              <Input
                id="pos-new-customer-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pos-new-customer-phone">{t().customers.phone}</Label>
              <Input
                id="pos-new-customer-phone"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={30}
                placeholder="012 345 678"
              />
              <p className="text-xs text-muted-foreground">
                {t().customers.phoneHint}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pos-new-customer-address">{t().customers.address}</Label>
              <Textarea
                id="pos-new-customer-address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                maxLength={300}
                rows={2}
              />
              <p className="text-xs text-muted-foreground">
                {t().customers.addressHint}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              disabled={creating || !name.trim()}
              onClick={() => void doCreate(false)}
            >
              {t().common.save}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={creating}
              onClick={() => setNewOpen(false)}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
              {t().common.cancel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={dupId !== null}
        onOpenChange={(open) => {
          if (!open) setDupId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t().customers.duplicateTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="flex flex-col gap-1">
                <span>{t().customers.duplicateBody}</span>
                {dupCustomer && (
                  <Badge variant="secondary" className="w-fit gap-1">
                    {dupCustomer.name}
                    {dupCustomer.phone ? ` · ${dupCustomer.phone}` : ""}
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
                const existing = dupCustomer;
                setDupId(null);
                if (existing) {
                  setNewOpen(false);
                  setName("");
                  setPhone("");
                  setAddress("");
                  onSelect(existing);
                }
              }}
            >
              {t().customers.useExisting}
            </AlertDialogAction>
            <Button
              type="button"
              onClick={() => {
                setDupId(null);
                void doCreate(true);
              }}
            >
              {t().customers.createAnyway}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
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
    const d = (
      err as {
        data: { customerId?: string; customerName?: string; customerPhone?: string };
      }
    ).data;
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
