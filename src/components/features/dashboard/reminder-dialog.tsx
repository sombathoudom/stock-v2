"use client";

import { Copy01Icon, TelegramIcon, WhatsappIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { toast } from "sonner";

import { buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatMoney, getLang, t, toastError } from "@/lib/utils";

// T20 — one-tap payment reminder for an owed order. One plain-language
// message, then hand it off: copy for any messenger, or open WhatsApp /
// Telegram with the text pre-filled. Nothing is sent by the app itself.

export type ReminderRow = {
  saleCode: string;
  customerName: string;
  customerPhone: string; // normalized digits — used as-is in the wa.me link
  remaining: number; // integer cents
};

export function ReminderDialog({
  open,
  onOpenChange,
  row,
  shopName,
  currency,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: ReminderRow | null;
  shopName: string;
  currency: string;
}) {
  const lang = getLang();
  const amount = row ? formatMoney(row.remaining, currency, lang) : "";

  const message = useMemo(() => {
    if (!row) return "";
    return t()
      .dashboard.reminderMessage.replace("{name}", row.customerName)
      .replace("{shop}", shopName)
      .replace("{code}", row.saleCode)
      .replace("{amount}", amount);
  }, [row, shopName, amount]);

  const whatsappUrl = row
    ? `https://wa.me/${row.customerPhone}?text=${encodeURIComponent(message)}`
    : "";
  const telegramUrl = row
    ? `https://t.me/share/url?url=&text=${encodeURIComponent(message)}`
    : "";

  function copyMessage() {
    navigator.clipboard.writeText(message).then(
      () => toast.success(t().dashboard.copied),
      (err) => toastError(err),
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t().dashboard.reminder}</DialogTitle>
          <DialogDescription>
            {row ? `${row.customerName} · ${row.customerPhone}` : ""}
          </DialogDescription>
        </DialogHeader>
        <p className="whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">
          {message}
        </p>
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={copyMessage}
            className={buttonVariants({ variant: "outline" })}
          >
            <HugeiconsIcon icon={Copy01Icon} size={16} />
            {t().dashboard.copy}
          </button>
          <a
            href={telegramUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "secondary" })}
          >
            <HugeiconsIcon icon={TelegramIcon} size={16} />
            {t().dashboard.openTelegram}
          </a>
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "default" })}
          >
            <HugeiconsIcon icon={WhatsappIcon} size={16} />
            {t().dashboard.openWhatsApp}
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
