"use client";

import {
  Cancel01Icon,
  FilterIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { useState } from "react";

import type { Id } from "@convex/_generated/dataModel";
import { CustomerFilter } from "@/components/features/sales/customer-filter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { t } from "@/lib/utils";

export type SalesStatusFilter =
  | "all"
  | "today"
  | "unpaid"
  | "draft"
  | "pending"
  | "confirmed"
  | "packed"
  | "delivering"
  | "delivered"
  | "partially_delivered"
  | "cancelled";

export type SalesPaymentFilter = "all" | "paid" | "partly_paid" | "unpaid";

const STATUS_FILTERS: SalesStatusFilter[] = [
  "all",
  "today",
  "unpaid",
  "confirmed",
  "pending",
  "packed",
  "delivering",
  "delivered",
  "partially_delivered",
  "cancelled",
];

const PAYMENT_FILTERS: SalesPaymentFilter[] = [
  "all",
  "paid",
  "partly_paid",
  "unpaid",
];

function statusLabel(filter: SalesStatusFilter): string {
  switch (filter) {
    case "all":
      return t().sales.allStatuses;
    case "today":
      return t().sales.today;
    case "unpaid":
      return t().sales.unpaid;
    default:
      return t().status[filter];
  }
}

function paymentLabel(filter: SalesPaymentFilter): string {
  switch (filter) {
    case "all":
      return t().sales.allPaymentStatuses;
    case "paid":
      return t().sales.paymentStatuses.paid;
    case "partly_paid":
      return t().sales.paymentStatuses.partlyPaid;
    case "unpaid":
      return t().sales.paymentStatuses.unpaid;
  }
}

type Props = {
  search: string;
  onSearchChange: (value: string) => void;
  status: SalesStatusFilter;
  onStatusChange: (value: SalesStatusFilter) => void;
  channelId: string;
  channels: { _id: Id<"salesChannels">; name: string }[];
  onChannelChange: (value: string) => void;
  fromDay: string;
  onFromDayChange: (value: string) => void;
  toDay: string;
  onToDayChange: (value: string) => void;
  customerId: Id<"customers"> | "all";
  onCustomerChange: (value: Id<"customers"> | "all") => void;
  paymentStatus: SalesPaymentFilter;
  onPaymentStatusChange: (value: SalesPaymentFilter) => void;
  onClear: () => void;
};

export function SalesFilterPanel(props: Props) {
  const [open, setOpen] = useState(false);
  const activeCount =
    Number(props.search.trim() !== "") +
    Number(props.status !== "all") +
    Number(props.channelId !== "all") +
    Number(props.fromDay !== "") +
    Number(props.toDay !== "") +
    Number(props.customerId !== "all") +
    Number(props.paymentStatus !== "all");

  return (
    <>
      <div className="px-4 pt-4 md:hidden">
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full justify-between"
          onClick={() => setOpen(true)}
        >
          <span className="flex items-center gap-2">
            <HugeiconsIcon icon={FilterIcon} strokeWidth={2} className="size-4" />
            {t().common.filter}
          </span>
          {activeCount > 0 ? <Badge>{activeCount}</Badge> : null}
        </Button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="max-h-[88dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          <SheetHeader className="border-b">
            <SheetTitle>{t().common.filter}</SheetTitle>
            <SheetDescription>{t().sales.filterHint}</SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-4">
            <FilterFields {...props} mobile />
          </div>
          <SheetFooter className="grid grid-cols-2 border-t">
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={activeCount === 0}
              onClick={props.onClear}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
              {t().sales.clearFilters}
            </Button>
            <Button type="button" className="h-11" onClick={() => setOpen(false)}>
              {t().common.close}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <div className="hidden items-center gap-1 overflow-x-auto px-4 pt-4 md:flex">
        <FilterFields {...props} />
      </div>
    </>
  );
}

function FilterFields({
  search,
  onSearchChange,
  status,
  onStatusChange,
  channelId,
  channels,
  onChannelChange,
  fromDay,
  onFromDayChange,
  toDay,
  onToDayChange,
  customerId,
  onCustomerChange,
  paymentStatus,
  onPaymentStatusChange,
  onClear,
  mobile = false,
}: Props & { mobile?: boolean }) {
  const fieldHeight = mobile ? "h-11" : "h-8";
  return (
    <div className={mobile ? "grid gap-4 py-4" : "flex items-center gap-1"}>
      <div className={mobile ? "grid gap-1.5" : "contents"}>
        {mobile ? <span className="text-sm font-medium">{t().common.search}</span> : null}
        <InputGroup className={mobile ? "h-11 w-full" : "h-8 w-38 shrink-0"}>
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-3.5" />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t().sales.searchCode}
            aria-label={t().sales.searchCode}
          />
        </InputGroup>
      </div>

      <FilterSelectLabel label={t().sales.status} mobile={mobile}>
        <Select
          value={status}
          items={Object.fromEntries(STATUS_FILTERS.map((item) => [item, statusLabel(item)]))}
          onValueChange={(value) => onStatusChange((value ?? "all") as SalesStatusFilter)}
        >
          <SelectTrigger size="sm" className={mobile ? "h-11 w-full" : "w-28 shrink-0 text-xs"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((item) => (
              <SelectItem key={item} value={item}>{statusLabel(item)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterSelectLabel>

      <FilterSelectLabel label={t().sales.channel} mobile={mobile}>
        <Select
          value={channelId}
          items={{
            all: t().sales.allChannels,
            ...Object.fromEntries(channels.map((channel) => [channel._id, channel.name])),
          }}
          onValueChange={(value) => onChannelChange(value ?? "all")}
        >
          <SelectTrigger size="sm" className={mobile ? "h-11 w-full" : "w-38 shrink-0 text-xs"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t().sales.allChannels}</SelectItem>
            {channels.map((channel) => (
              <SelectItem key={channel._id} value={channel._id}>{channel.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterSelectLabel>

      <label className={mobile ? "grid gap-1.5" : "flex shrink-0 items-center gap-1"}>
        <span className={mobile ? "text-sm font-medium" : "text-xs text-muted-foreground"}>
          {t().sales.fromDate}
        </span>
        <Input
          type="date"
          value={fromDay}
          onChange={(event) => onFromDayChange(event.target.value)}
          className={mobile ? "h-11 w-full" : "h-8 w-28 px-1 text-xs"}
        />
      </label>

      <label className={mobile ? "grid gap-1.5" : "flex shrink-0 items-center gap-1"}>
        <span className={mobile ? "text-sm font-medium" : "text-xs text-muted-foreground"}>
          {t().sales.toDate}
        </span>
        <Input
          type="date"
          value={toDay}
          onChange={(event) => onToDayChange(event.target.value)}
          className={mobile ? "h-11 w-full" : "h-8 w-28 px-1 text-xs"}
        />
      </label>

      <div className={mobile ? "grid gap-1.5" : "w-48 shrink-0"}>
        {mobile ? <span className="text-sm font-medium">{t().sales.customer}</span> : null}
        <CustomerFilter value={customerId} onChange={onCustomerChange} className={fieldHeight} />
      </div>

      <FilterSelectLabel label={t().sales.paymentStatus} mobile={mobile}>
        <Select
          value={paymentStatus}
          items={Object.fromEntries(PAYMENT_FILTERS.map((item) => [item, paymentLabel(item)]))}
          onValueChange={(value) =>
            onPaymentStatusChange((value ?? "all") as SalesPaymentFilter)
          }
        >
          <SelectTrigger size="sm" className={mobile ? "h-11 w-full" : "w-40 shrink-0 text-xs"}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_FILTERS.map((item) => (
              <SelectItem key={item} value={item}>{paymentLabel(item)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FilterSelectLabel>

      {!mobile ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 text-xs"
          disabled={
            search === "" && status === "all" && channelId === "all" &&
            fromDay === "" && toDay === "" && customerId === "all" &&
            paymentStatus === "all"
          }
          onClick={onClear}
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
          {t().sales.clearFilters}
        </Button>
      ) : null}
    </div>
  );
}

function FilterSelectLabel({
  label,
  mobile,
  children,
}: {
  label: string;
  mobile: boolean;
  children: ReactNode;
}) {
  return (
    <div className={mobile ? "grid gap-1.5" : "contents"}>
      {mobile ? <span className="text-sm font-medium">{label}</span> : null}
      {children}
    </div>
  );
}
