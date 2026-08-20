"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Cancel01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState } from "react";
import { FormProvider, useController, useForm, useFormContext } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { FormField } from "@/components/features/forms/form-field";
import {
  FormMoney,
  moneyInputSchema,
  optionalMoneySchema,
} from "@/components/features/forms/form-money";
import {
  FormSelect,
  type FormSelectOption,
} from "@/components/features/forms/form-select";
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
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { useCurrentUser } from "@/hooks/use-current-user";
import { useShop } from "@/hooks/use-shop";
import {
  centsToInput,
  formatDateTime,
  formatMoney,
  getLang,
  inputToCents,
  t,
  toastError,
} from "@/lib/utils";
import {
  SaleEditItemsTable,
  lineChanged,
  lineDiscount,
  lineError,
  linePrice,
  lineQty,
  lineSubtotal,
  type EditLine,
} from "./sale-edit-items-table";
import { ALL_STATUSES, NEXT_STEPS, type SaleStatus } from "./sale-status-flow";

// T12 — the full-page order editor. Items, order fields and status are edited
// together and saved in ONE mutation, which is ONE Convex transaction: either
// every stock movement lands or none does. Nothing on this page touches the
// database until Save.

export type SaleEditData = NonNullable<
  FunctionReturnType<typeof api.sales.getEditData>
>;

const schema = z.object({
  customerId: z.string().min(1),
  channelId: z.string().min(1),
  companyId: z.string(), // "" = Self / pickup
  status: z.string().min(1),
  deliveryFee: optionalMoneySchema,
  deliveryCost: optionalMoneySchema,
  discount: moneyInputSchema,
  note: z.string().max(500),
});

type FormValues = z.infer<typeof schema>;

/** Customer picker with SERVER-side search (name/phone, debounced). The
 * current customer's label is seeded so a deactivated one still shows its
 * name instead of a bare id. */
function CustomerField({ seedLabel }: { seedLabel: string }) {
  const { control } = useFormContext();
  const { field, fieldState } = useController({ control, name: "customerId" });
  const user = useCurrentUser();

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

  return (
    <FormField
      label={t().sales.customer}
      htmlFor="sale-edit-customer"
      required
      error={fieldState.error?.message}
    >
      <Combobox
        items={(customers ?? []).map((c) => c._id)}
        itemToStringLabel={(item) => {
          if (item == null) return "";
          const value =
            typeof item === "object" && "value" in item
              ? String((item as { value: unknown }).value)
              : String(item);
          if (value === field.value) return labelById.get(value) ?? seedLabel;
          return labelById.get(value) ?? value;
        }}
        value={(field.value as string | undefined) ?? null}
        onValueChange={(value) => field.onChange(value ?? "")}
        // Only user typing drives the server search — Base UI's programmatic
        // fills (selection sync) arrive with a different reason.
        onInputValueChange={(inputValue, eventDetails) => {
          if (eventDetails?.reason === "input-change") setQuery(inputValue);
        }}
      >
        <ComboboxInput
          id="sale-edit-customer"
          placeholder={t().sales.searchCustomers}
          showClear
          aria-invalid={fieldState.error != null}
          onFocus={(e) => (e.target as HTMLInputElement).select()}
        />
        <ComboboxContent>
          <ComboboxEmpty>{t().sales.noCustomers}</ComboboxEmpty>
          <ComboboxList>
            {(customers ?? []).map((c) => (
              <ComboboxItem key={c._id} value={c._id}>
                <span className="truncate">{c.name}</span>
                {c.phone ? (
                  <span className="text-xs text-muted-foreground">· {c.phone}</span>
                ) : null}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </FormField>
  );
}

/** The order's lines as editable rows. `maxQty` comes from the server: the
 * pieces this line already bills plus what's left on the shelf. */
function toEditLines(data: SaleEditData): EditLine[] {
  return data.items.map(({ item, variant, product, billedQty, maxQty }) => ({
    key: item._id,
    saleItemId: item._id,
    variantId: variant._id,
    productName: product.name,
    variantLabel: variant.color ? `${variant.size} · ${variant.color}` : variant.size,
    sku: variant.sku,
    imageStorageId: product.imageStorageId,
    qty: String(billedQty),
    price: centsToInput(item.unitPrice),
    discount: item.discount ? centsToInput(item.discount) : "",
    originalQty: billedQty,
    originalPrice: item.unitPrice,
    originalDiscount: item.discount ?? 0,
    qtyDelivered: item.qtyDelivered,
    qtyReturned: item.qtyReturned,
    maxQty,
    // A line that already bills nothing was cancelled or returned long ago.
    // It opens in the removed state — it is history, not a row to fix.
    removed: billedQty === 0,
  }));
}

export function SaleEditForm({
  data,
  onDone,
}: {
  data: SaleEditData;
  onDone: () => void;
}) {
  const shop = useShop();
  const lang = getLang();
  const labels = t().sales.edit;
  const currency = shop?.currency ?? "USD";
  const deliveryEnabled = shop?.deliveryEnabled === true;

  const saveEdit = useMutation(api.sales.saveEdit);
  const channels = useQuery(api.channels.listActive, {});
  const companies = useQuery(api.deliveryCompanies.listActive, {});

  const sale = data.sale;
  const [lines, setLines] = useState<EditLine[]>(() => toEditLines(data));
  const [saving, setSaving] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      customerId: sale.customerId,
      channelId: sale.salesChannelId,
      companyId: sale.deliveryCompanyId ?? "",
      // The order opens on the status it already has (never a blank field).
      status: sale.status,
      deliveryFee: sale.deliveryFee > 0 ? centsToInput(sale.deliveryFee) : "",
      deliveryCost: sale.deliveryCost > 0 ? centsToInput(sale.deliveryCost) : "",
      discount: centsToInput(sale.discount),
      note: sale.note ?? "",
    },
  });

  // The current channel/company may be inactive and missing from the active
  // lists — keep a fallback option so the field still shows its name.
  const channelOptions = useMemo<FormSelectOption[]>(() => {
    const list = (channels ?? []).map((c) => ({ value: c._id, label: c.name }));
    if (!list.some((o) => o.value === sale.salesChannelId)) {
      list.unshift({ value: sale.salesChannelId, label: data.channel.name });
    }
    return list;
  }, [channels, sale.salesChannelId, data.channel.name]);

  const companyOptions = useMemo<FormSelectOption[]>(() => {
    const list: FormSelectOption[] = [
      { value: "", label: t().sales.noCompany },
      ...(companies ?? []).map((c) => ({ value: c._id, label: c.name })),
    ];
    if (
      sale.deliveryCompanyId &&
      !list.some((o) => o.value === sale.deliveryCompanyId) &&
      data.company
    ) {
      list.push({ value: sale.deliveryCompanyId, label: data.company.name });
    }
    return list;
  }, [companies, sale.deliveryCompanyId, data.company]);

  // Every delivery stage stays visible so the whole journey is legible; the
  // ones this order can't reach from here are greyed, exactly as the server's
  // ALLOWED_TRANSITIONS would refuse them.
  const statusOptions = useMemo<FormSelectOption[]>(() => {
    const allowed = NEXT_STEPS[sale.status] ?? [];
    const options: FormSelectOption[] = ALL_STATUSES.map((status) => ({
      value: status,
      label:
        status === sale.status
          ? `${t().status[status]} · ${t().sales.statusNow}`
          : t().status[status],
      disabled: status !== sale.status && !allowed.includes(status),
    }));
    // A status the list doesn't carry (a draft) must still show rather than
    // silently reset the field to something else.
    if (!options.some((o) => o.value === sale.status)) {
      options.unshift({
        value: sale.status,
        label: `${t().status[sale.status]} · ${t().sales.statusNow}`,
      });
    }
    return options;
  }, [sale.status]);

  const seedLabel = `${data.customer.name}${
    data.customer.phone ? ` · ${data.customer.phone}` : ""
  }`;

  // --- Live totals. Display only: the server recomputes every one of these
  // from its own rows on save and is the one that decides. ---
  const itemsSubtotal = lines.reduce((sum, l) => sum + lineSubtotal(l), 0);
  const orderDiscount = inputToCents(form.watch("discount")) ?? 0;
  const shippingFee = deliveryEnabled
    ? (inputToCents(form.watch("deliveryFee")) ?? 0)
    : sale.deliveryFee;
  const total = Math.max(0, itemsSubtotal - orderDiscount + shippingFee);
  const remaining = total - data.paid;

  const rowErrors = lines.some((l) => lineError(l) != null);
  const liveLines = lines.filter((l) => !l.removed).length;
  const dirty =
    form.formState.isDirty ||
    lines.length !== data.items.length ||
    lines.some((l) => lineChanged(l));

  // Warn before a reload/close throws the edits away — the same promise the
  // Cancel button makes, enforced by the browser.
  useEffect(() => {
    if (!dirty || saving) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, saving]);

  async function save(values: FormValues) {
    // Guard against a double click before the disabled state re-renders —
    // the second save would land on a bumped version and look like a conflict.
    if (saving) return;
    if (rowErrors) {
      toast.error(labels.fixErrors);
      return;
    }
    setSaving(true);
    try {
      // Only ids, quantities and intents cross the wire — the server re-derives
      // every price, cost and total from the database (AGENTS.md).
      const items = lines.map((line) => {
        const qty = line.removed ? 0 : (lineQty(line) ?? 0);
        const price = linePrice(line) ?? undefined;
        const discount = lineDiscount(line);
        if (line.saleItemId !== undefined) {
          return {
            saleItemId: line.saleItemId,
            qty,
            // null clears a discount the line used to carry.
            discount: discount != null && discount > 0 ? discount : null,
            ...(price !== undefined ? { price } : {}),
          };
        }
        return {
          variantId: line.variantId,
          qty,
          ...(discount != null && discount > 0 ? { discount } : {}),
          ...(price !== undefined ? { price } : {}),
        };
      });

      await saveEdit({
        saleId: sale._id,
        // The version this page loaded — the server refuses the save when the
        // order changed in another window since (stale-edit guard).
        expectedVersion: data.version,
        items,
        customerId: values.customerId as Id<"customers">,
        salesChannelId: values.channelId as Id<"salesChannels">,
        // Delivery fields only when the module is on — the server rejects them
        // otherwise (and keeps the current values).
        ...(deliveryEnabled
          ? {
              deliveryCompanyId: (values.companyId ||
                null) as Id<"deliveryCompanies"> | null,
              deliveryFee:
                values.deliveryFee === "" ? null : inputToCents(values.deliveryFee),
              deliveryCost:
                values.deliveryCost === "" ? null : inputToCents(values.deliveryCost),
            }
          : {}),
        discount: inputToCents(values.discount) ?? 0,
        note: values.note.trim() || null,
        ...(values.status !== sale.status
          ? { status: values.status as SaleStatus }
          : {}),
      });
      toast.success(labels.saved);
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    if (dirty) {
      setConfirmLeave(true);
      return;
    }
    onDone();
  }

  return (
    <FormProvider {...form}>
      <form
        onSubmit={form.handleSubmit((values) => void save(values))}
        className="flex flex-col gap-4 pb-24 md:pb-0"
        noValidate
      >
        <Card>
          <CardHeader>
            <CardTitle>{labels.orderCard}</CardTitle>
            <CardDescription>
              {sale.code} ·{" "}
              {formatDateTime(
                sale.createdAt,
                shop?.timezone ?? "Asia/Phnom_Penh",
                lang
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <CustomerField seedLabel={seedLabel} />
              <FormSelect
                name="channelId"
                label={t().sales.channel}
                options={channelOptions}
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormSelect
                name="status"
                label={t().sales.status}
                options={statusOptions}
                hint={t().sales.statusPickHint}
                required
              />
              {deliveryEnabled ? (
                <FormSelect
                  name="companyId"
                  label={t().sales.company}
                  options={companyOptions}
                />
              ) : null}
            </div>
            <FormTextarea
              name="note"
              label={t().sales.saleNote}
              hint={t().sales.saleNoteHint}
              rows={2}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{labels.itemsCard}</CardTitle>
            <CardDescription>{labels.itemsCardHint}</CardDescription>
          </CardHeader>
          <CardContent>
            <SaleEditItemsTable
              lines={lines}
              onChange={setLines}
              currency={currency}
              disabled={saving}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{labels.summaryCard}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <FormMoney
                name="discount"
                label={`${t().sales.orderDiscount} (${currency})`}
                placeholder="0.00"
                hint={t().sales.orderDiscountHint}
              />
              {deliveryEnabled ? (
                <FormMoney
                  name="deliveryFee"
                  label={`${t().sales.deliveryFee} (${currency})`}
                  placeholder="0.00"
                  hint={t().sales.deliveryFeeHint}
                />
              ) : null}
            </div>
            {deliveryEnabled ? (
              <FormMoney
                name="deliveryCost"
                label={`${t().sales.companyCost} (${currency})`}
                placeholder="0.00"
                hint={t().sales.companyCostHint}
              />
            ) : null}
            <dl className="flex flex-col gap-1 border-t pt-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{labels.itemsSubtotal}</dt>
                <dd className="tabular-nums">{formatMoney(itemsSubtotal, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t().sales.orderDiscount}</dt>
                <dd className="tabular-nums">−{formatMoney(orderDiscount, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t().sales.deliveryFee}</dt>
                <dd className="tabular-nums">{formatMoney(shippingFee, currency)}</dd>
              </div>
              <div className="flex items-center justify-between border-t pt-2 font-semibold">
                <dt>{t().sales.total}</dt>
                <dd className="tabular-nums">{formatMoney(total, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{t().sales.paid}</dt>
                <dd className="tabular-nums">{formatMoney(data.paid, currency)}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">{labels.stillOwed}</dt>
                <dd className="tabular-nums">{formatMoney(remaining, currency)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Sticky action bar on a phone, a plain footer card from md up. */}
        <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur md:static md:rounded-md md:border md:p-4 md:pb-4">
          <div className="mx-auto flex max-w-7xl items-center gap-2">
            <Button type="submit" disabled={saving || rowErrors || liveLines === 0}>
              <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="size-4" />
              {saving ? labels.saving : labels.saveChanges}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={cancel}
              disabled={saving}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
              {t().common.cancel}
            </Button>
            <span className="ms-auto text-sm font-semibold tabular-nums">
              {formatMoney(total, currency)}
            </span>
          </div>
        </div>

        <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{labels.unsavedTitle}</AlertDialogTitle>
              <AlertDialogDescription>{labels.unsavedBody}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{labels.unsavedStay}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmLeave(false);
                  onDone();
                }}
              >
                {labels.unsavedLeave}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </form>
    </FormProvider>
  );
}
