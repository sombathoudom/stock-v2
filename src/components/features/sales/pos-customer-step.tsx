"use client";

import { Cancel01Icon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@convex/_generated/api";
import type { Doc } from "@convex/_generated/dataModel";
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
// New-customer creation atomically reuses an existing normalized phone, so a
// repeat entry selects that customer instead of creating another record.

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
  const createOrGet = useMutation(api.customers.createOrGetByPhone);

  async function doCreate() {
    setCreating(true);
    try {
      const result = await createOrGet({
        name,
        phone: phone.trim() || undefined,
        address: address.trim() || undefined,
      });
      toast.success(
        result.created ? t().customers.created : t().customers.existingSelected
      );
      setNewOpen(false);
      setName("");
      setPhone("");
      setAddress("");
      onSelect(result.customer);
    } catch (err) {
      toastError(err);
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
              onClick={() => void doCreate()}
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

    </>
  );
}
