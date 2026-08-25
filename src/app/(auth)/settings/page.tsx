"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  Cancel01Icon,
  Download01Icon,
  EllipsisVerticalIcon,
  Key01Icon,
  PlusSignIcon,
  PrinterIcon,
  Settings01Icon,
  UsbConnected01Icon,
  UserBlock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useConvex, useMutation, useQuery } from "convex/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { z } from "zod";

import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/features/data-table/data-table";
import { FormCombobox } from "@/components/features/forms/form-combobox";
import { FormInput } from "@/components/features/forms/form-input";
import { FormSelect } from "@/components/features/forms/form-select";
import { FormSwitch } from "@/components/features/forms/form-switch";
import { FormTextarea } from "@/components/features/forms/form-textarea";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-current-user";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { authClient } from "@/lib/auth-client";
import {
  printTestDoc,
  scanUsbPrinter,
  toastPrintError,
  usbSupported,
  type ThermalConfig,
} from "@/lib/printing";
import { downloadJson, t, toastError } from "@/lib/utils";

// T1 — Shop settings + team (AGENTS.md). Owner-only page: the Convex
// functions enforce the role server-side; the UI below just reflects it.

const settingsSchema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  currency: z
    .string()
    .trim()
    .min(1, "Required")
    .max(8)
    .transform((value) => value.toUpperCase()),
  timezone: z.string().min(1, "Required"),
  language: z.enum(["en", "km"]),
  deliveryEnabled: z.boolean(),
  address: z.string().trim().max(500),
  exchangeRate: z.coerce.number().positive().max(1_000_000),
  lowStockThreshold: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.coerce.number().int().min(0).max(1_000_000).optional(),
  ),
  // Sentinel for "no default" — Base UI treats "" as no-value, so the
  // walk-in fallback gets a real string option (mapped to null on save).
  defaultCustomerId: z.string(),
  // T25 printer — "" means "no thermal printer" (the saved config is removed).
  printerType: z.enum(["", "webusb", "qz_tray", "network"]),
  vendorId: z.string().trim().max(4).regex(/^[0-9a-fA-F]*$/, "Hex only"),
  productId: z.string().trim().max(4).regex(/^[0-9a-fA-F]*$/, "Hex only"),
  qzPrinterName: z.string().trim().max(200),
  qzCert: z.string().trim().max(20_000),
  networkHost: z.string().trim().max(253),
  networkPort: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.coerce.number().int().min(1).max(65535).optional(),
  ),
});

// z.coerce / z.preprocess widen the raw input type (unknown). zodResolver is
// typed Resolver<Input, any, Output>: RHF field values use the input type,
// and handleSubmit receives the validated output type.
type SettingsFormInput = z.input<typeof settingsSchema>;
type SettingsFormValues = z.output<typeof settingsSchema>;

// Base UI treats "" as "no value" and can't render it as a selectable
// option — a sentinel stands in for "no default configured" (the POS falls
// back to the walk-in customer), mapped to null in savePayload().
const DEFAULT_CUSTOMER_NONE = "__walk_in__";

const DEFAULT_VALUES: SettingsFormValues = {
  name: "",
  currency: "USD",
  timezone: "Asia/Phnom_Penh",
  language: "en",
  deliveryEnabled: false,
  address: "",
  exchangeRate: 1,
  lowStockThreshold: undefined,
  defaultCustomerId: DEFAULT_CUSTOMER_NONE,
  printerType: "",
  vendorId: "",
  productId: "",
  qzPrinterName: "",
  qzCert: "",
  networkHost: "",
  networkPort: undefined,
};

/** USB ids are saved as integers; the form edits them as 4-digit hex. */
function toHex(value: number): string {
  return value.toString(16).padStart(4, "0");
}

function shopToValues(shop: Doc<"shop">): SettingsFormValues {
  const cfg = shop.printerConfig;
  return {
    name: shop.name,
    currency: shop.currency,
    timezone: shop.timezone,
    language: shop.language,
    deliveryEnabled: shop.deliveryEnabled,
    address: shop.address ?? "",
    exchangeRate: shop.exchangeRate,
    lowStockThreshold: shop.lowStockThreshold,
    defaultCustomerId: shop.defaultCustomerId ?? DEFAULT_CUSTOMER_NONE,
    printerType: cfg?.type ?? "",
    vendorId: cfg?.vendorId != null ? toHex(cfg.vendorId) : "",
    productId: cfg?.productId != null ? toHex(cfg.productId) : "",
    qzPrinterName: cfg?.qzPrinterName ?? "",
    qzCert: cfg?.qzCert ?? "",
    networkHost: cfg?.networkHost ?? "",
    networkPort: cfg?.networkPort,
  };
}

/** Form values → the printer config the mutation stores. "" type (or any
 * unset ids) means no thermal printer — the saved config is removed. */
function formToThermalConfig(
  values: SettingsFormValues
): ThermalConfig | undefined {
  if (!values.printerType) return undefined;
  return {
    type: values.printerType,
    vendorId: values.vendorId ? parseInt(values.vendorId, 16) : undefined,
    productId: values.productId ? parseInt(values.productId, 16) : undefined,
    qzPrinterName: values.qzPrinterName || undefined,
    qzCert: values.qzCert || undefined,
    networkHost: values.networkHost || undefined,
    networkPort: values.networkPort,
  };
}

/** The exact args for api.shop.save — picked field by field, because the
 * form also holds printer fields that only exist INSIDE printerConfig (the
 * save validator rejects extra top-level fields). "" printer type → undefined
 * removes a saved printer config (shop.save always patches the field —
 * convex/shop.ts). */
function savePayload(values: SettingsFormValues) {
  return {
    name: values.name,
    currency: values.currency,
    timezone: values.timezone,
    language: values.language,
    deliveryEnabled: values.deliveryEnabled,
    address: values.address || undefined,
    exchangeRate: values.exchangeRate,
    lowStockThreshold: values.lowStockThreshold,
    // Sentinel → null clears the default (POS falls back to walk-in); the
    // id is otherwise written as-is (existence-checked server-side).
    defaultCustomerId:
      values.defaultCustomerId &&
      values.defaultCustomerId !== DEFAULT_CUSTOMER_NONE
        ? (values.defaultCustomerId as Id<"customers">)
        : null,
    printerConfig: formToThermalConfig(values),
  };
}

const FALLBACK_TIMEZONES = [
  "Asia/Phnom_Penh",
  "Asia/Bangkok",
  "Asia/Ho_Chi_Minh",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Europe/London",
  "Europe/Paris",
  "America/New_York",
  "America/Los_Angeles",
  "UTC",
];

/** Per-row role dropdown (shared by the desktop table and the phone cards). */
function RoleSelect({
  userId,
  role,
  disabled,
}: {
  userId: string;
  role: "owner" | "staff";
  disabled?: boolean;
}) {
  const setRole = useMutation(api.users.setRole);
  const [pending, setPending] = useState(false);

  return (
    <Select
      value={role}
      disabled={disabled || pending}
      // Base UI shows the RAW value in the trigger without this map.
      items={{ owner: t().common.roleOwner, staff: t().common.roleStaff }}
      onValueChange={(value) => {
        setPending(true);
        setRole({ userId: userId as Doc<"users">["_id"], role: value as "owner" | "staff" })
          .catch(toastError)
          .finally(() => setPending(false));
      }}
    >
      <SelectTrigger size="sm" className="w-28" aria-label={t().settings.changeRole}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="owner">{t().common.roleOwner}</SelectItem>
        <SelectItem value="staff">{t().common.roleStaff}</SelectItem>
      </SelectContent>
    </Select>
  );
}

/** Per-row management menu: reset password / deactivate–reactivate. Every
 * action is owner-only on the server; self-actions are refused there too
 * (the disabled state here is just UX). */
function UserRowActions({
  target,
  selfId,
  onResetPassword,
  onToggleActive,
}: {
  target: Doc<"users">;
  selfId?: Id<"users">;
  onResetPassword: (target: Doc<"users">) => void;
  onToggleActive: (target: Doc<"users">) => void;
}) {
  const isSelf = target._id === selfId;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 sm:size-8"
            aria-label={t().common.actions}
            disabled={isSelf}
          />
        }
      >
        <HugeiconsIcon icon={EllipsisVerticalIcon} strokeWidth={2} className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="w-56">
        {target.active ? (
          <>
            <DropdownMenuItem
              className="min-h-11 sm:min-h-8"
              onClick={() => onResetPassword(target)}
            >
              <HugeiconsIcon icon={Key01Icon} strokeWidth={2} className="size-4" />
              {t().settings.resetPassword}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 sm:min-h-8 text-destructive data-highlighted:text-destructive"
              onClick={() => onToggleActive(target)}
            >
              <HugeiconsIcon
                icon={UserBlock01Icon}
                strokeWidth={2}
                className="size-4"
              />
              {t().settings.deactivateConfirm}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem
            className="min-h-11 sm:min-h-8"
            onClick={() => onToggleActive(target)}
          >
            <HugeiconsIcon icon={Key01Icon} strokeWidth={2} className="size-4" />
            {t().settings.activateConfirm}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const resetPasswordSchema = z
  .object({
    newPassword: z.string().trim().min(8).max(128),
    confirmPassword: z.string().trim(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords do not match",
  });

type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

const addStaffSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email(),
  password: z.string().trim().min(8).max(128),
  role: z.enum(["owner", "staff"]),
});

type AddStaffValues = z.infer<typeof addStaffSchema>;

/** Owner invites a staff member: creates the sign-in + staff record in one
 * step, with the role chosen up front. */
function AddStaffDialog({ onClose }: { onClose: () => void }) {
  const createStaff = useMutation(api.users.createStaff);
  const [saving, setSaving] = useState(false);
  const form = useForm<AddStaffValues>({
    resolver: zodResolver(addStaffSchema),
    defaultValues: { name: "", email: "", password: "", role: "staff" },
  });

  async function onSubmit(values: AddStaffValues) {
    setSaving(true);
    try {
      const created = await createStaff(values);
      toast.success(
        t().settings.staffCreated.replace("{name}", created.name),
      );
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t().settings.addStaff}</DialogTitle>
          <DialogDescription>{t().settings.addStaffHint}</DialogDescription>
        </DialogHeader>
        <FormProvider {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-3"
            noValidate
          >
            <FormInput
              name="name"
              label={t().settings.staffName}
              required
              autoComplete="off"
            />
            <FormInput
              name="email"
              label={t().settings.staffEmail}
              type="email"
              required
              autoComplete="off"
            />
            <FormInput
              name="password"
              label={t().settings.startPassword}
              type="password"
              hint={t().settings.resetPasswordHint}
              required
              autoComplete="new-password"
            />
            <FormSelect
              name="role"
              label={t().common.role}
              options={[
                { value: "staff", label: t().common.roleStaff },
                { value: "owner", label: t().common.roleOwner },
              ]}
              required
            />
            <DialogFooter className="gap-2">
              <Button type="button" variant="destructive" onClick={onClose}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
                {t().common.cancel}
              </Button>
              <Button type="submit" disabled={saving}>
                {t().common.add}
              </Button>
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}

/** Owner sets a staff member's new password (they forgot theirs). The
 * server hashes through Better Auth and updates its credential account. */
function ResetPasswordDialog({
  target,
  onClose,
}: {
  target: Doc<"users">;
  onClose: () => void;
}) {
  const resetPassword = useMutation(api.users.resetPassword);
  const [saving, setSaving] = useState(false);
  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { newPassword: "", confirmPassword: "" },
  });

  async function onSubmit(values: ResetPasswordValues) {
    setSaving(true);
    try {
      await resetPassword({ userId: target._id, newPassword: values.newPassword });
      toast.success(
        t().settings.resetPasswordDone.replace("{name}", target.name),
      );
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t().settings.resetPassword}</DialogTitle>
          <DialogDescription>
            {target.name} · {t().settings.resetPasswordHint}
          </DialogDescription>
        </DialogHeader>
        <FormProvider {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col gap-3"
            noValidate
          >
            <FormInput
              name="newPassword"
              label={t().settings.newPassword}
              type="password"
              required
              autoComplete="new-password"
            />
            <FormInput
              name="confirmPassword"
              label={t().settings.confirmPassword}
              type="password"
              required
              autoComplete="new-password"
            />
            <DialogFooter className="gap-2">
              <Button type="button" variant="destructive" onClick={onClose}>
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
                {t().common.cancel}
              </Button>
              <Button type="submit" disabled={saving}>
                {t().common.save}
              </Button>
            </DialogFooter>
          </form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
}

/** Deactivation confirm — goods/history language, never "delete". */
function DeactivateDialog({
  target,
  onClose,
}: {
  target: Doc<"users">;
  onClose: () => void;
}) {
  const setActive = useMutation(api.users.setActive);
  const [saving, setSaving] = useState(false);

  async function confirm() {
    setSaving(true);
    try {
      await setActive({ userId: target._id, active: false });
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t().settings.deactivateTitle}</DialogTitle>
          <DialogDescription>
            {target.name} — {t().settings.deactivateBody}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
            {t().common.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => void confirm()}
            disabled={saving}
          >
            <HugeiconsIcon
              icon={UserBlock01Icon}
              strokeWidth={2}
              className="size-4"
            />
            {t().settings.deactivateConfirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LoadingPage() {
  return (
    <div className="flex w-full flex-col gap-6 p-4">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-72 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export default function SettingsPage() {
  const user = useCurrentUser();
  const shop = useQuery(api.shop.get);
  const save = useMutation(api.shop.save);
  // Default-customer combobox options: active customers only (capped at
  // 100 server-side). The walk-in record is hidden — the sentinel option
  // below already stands for it.
  const customers =
    useQuery(api.customers.listActive, user == null ? "skip" : {}) ?? [];
  const ensureDefaults = useMutation(api.shop.ensureDefaults);
  const { data: session } = authClient.useSession();
  const convex = useConvex();
  const [backingUp, setBackingUp] = useState(false);

  // Staff have no business here — bounce them to the dashboard (the server
  // already rejects their calls; this is the UX half of the guard).
  const router = useRouter();
  useEffect(() => {
    if (user != null && user.role !== "owner") router.replace("/dashboard");
  }, [user, router]);

  // T24 — one-click full JSON backup of every table (owner-only on the
  // server too). Per-table truncation flags are inside the file.
  async function downloadBackup() {
    try {
      setBackingUp(true);
      const backup = await convex.query(api.backup.backupData, {});
      downloadJson(`pos-backup-${new Date().toISOString().slice(0, 10)}.json`, backup);
      toast.success(t().settings.backupDone.replace("{n}", String(backup.tables.length)));
    } catch (err) {
      toastError(err);
    } finally {
      setBackingUp(false);
    }
  }

  // Seed the default shop row + walk-in channel + walk-in customer once the
  // owner's session (and its Convex token) is loaded. The mutation is
  // idempotent — it also repairs shops created before the seeds shipped, so
  // it runs on every visit (two indexed reads + at most one insert).
  useEffect(() => {
    if (user?.role === "owner" && session && shop !== undefined) {
      ensureDefaults().catch(toastError);
    }
  }, [user, shop, session, ensureDefaults]);

  // TContext is unused here — `unknown` keeps the resolver typing without
  // opening the door to an untyped context object.
  const form = useForm<SettingsFormInput, unknown, SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: DEFAULT_VALUES,
  });

  useEffect(() => {
    if (shop) form.reset(shopToValues(shop));
  }, [shop, form]);

  const timezoneOptions = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone").map((value) => ({ value, label: value }));
    } catch {
      return FALLBACK_TIMEZONES.map((value) => ({ value, label: value }));
    }
  }, []);

  // --- Team list (server-side paginated; the query is owner-only) ---
  const [pageSize, setPageSize] = usePersistentState("settings:users:pageSize", 20);
  const [pageIndex, setPageIndex] = useState(0);
  const [cursors, setCursors] = useState<string[]>([]);
  const usersPage = useQuery(
    api.users.list,
    user?.role === "owner"
      ? {
          paginationOpts: {
            numItems: pageSize,
            cursor: pageIndex === 0 ? null : (cursors[pageIndex - 1] ?? null),
          },
        }
      : "skip",
  );

  // Team management (owner-only): add staff, reset password, deactivate.
  const setActive = useMutation(api.users.setActive);
  const [resetTarget, setResetTarget] = useState<Doc<"users"> | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<Doc<"users"> | null>(null);
  const [addStaffOpen, setAddStaffOpen] = useState(false);

  // Reactivation is safe — one tap, no confirm.
  const activate = useCallback(
    async (target: Doc<"users">) => {
      try {
        await setActive({ userId: target._id, active: true });
      } catch (err) {
        toastError(err);
      }
    },
    [setActive],
  );

  const columns = useMemo<DataTableColumn<Doc<"users">>[]>(
    () => [
      {
        accessorKey: "name",
        header: t().common.name,
        cell: ({ row }) => (
          <span className={row.original.active ? "" : "text-muted-foreground line-through"}>
            {row.original.name}
          </span>
        ),
      },
      {
        accessorKey: "email",
        header: t().common.email,
        cell: ({ row }) => row.original.email,
      },
      {
        accessorKey: "active",
        header: t().common.active,
        cell: ({ row }) => (
          <Badge variant={row.original.active ? "success" : "secondary"}>
            {row.original.active ? t().settings.userActive : t().settings.userInactive}
          </Badge>
        ),
      },
      {
        accessorKey: "role",
        header: t().common.role,
        cell: ({ row }) => (
          <Badge variant={row.original.role === "owner" ? "default" : "secondary"}>
            {row.original.role === "owner" ? t().common.roleOwner : t().common.roleStaff}
          </Badge>
        ),
      },
      {
        id: "changeRole",
        header: t().settings.changeRole,
        cell: ({ row }) => (
          <RoleSelect
            userId={row.original._id}
            role={row.original.role}
            disabled={row.original._id === user?._id || !row.original.active}
          />
        ),
      },
      {
        id: "userActions",
        header: t().common.actions,
        cell: ({ row }) => (
          <UserRowActions
            target={row.original}
            selfId={user?._id}
            onResetPassword={setResetTarget}
            onToggleActive={(target) =>
              target.active ? setDeactivateTarget(target) : void activate(target)
            }
          />
        ),
      },
    ],
    [user?._id, activate],
  );

  const [saving, setSaving] = useState(false);

  async function onSubmit(values: SettingsFormValues) {
    setSaving(true);
    try {
      await save(savePayload(values));
      toast.success(t().settings.saved);
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  }

  // --- T25 printer card ---

  const printerType = form.watch("printerType");
  const [scanning, setScanning] = useState(false);
  const [testing, setTesting] = useState(false);

  async function handleScanUsb() {
    setScanning(true);
    try {
      const ids = await scanUsbPrinter();
      form.setValue("vendorId", toHex(ids.vendorId), { shouldDirty: true });
      form.setValue("productId", toHex(ids.productId), { shouldDirty: true });
      toast.success(t().settings.printerScanDone);
    } catch (err) {
      toastPrintError(err);
    } finally {
      setScanning(false);
    }
  }

  async function handleTestPrint() {
    // getValues() returns the raw pre-coerce input shape; the coerced shape
    // only exists at submit. This cast is safe — the test print just reads
    // what the owner typed, and server-side validation still governs saving.
    const values = form.getValues() as unknown as SettingsFormValues;
    const cfg = formToThermalConfig(values);
    if (!cfg) {
      toastPrintError(new Error(t().errors.PRINT_NO_PRINTER));
      return;
    }
    setTesting(true);
    try {
      let finalCfg: ThermalConfig = cfg;
      if (cfg.type === "network") {
        // The server prints to the SAVED settings only (SSRF defense — the
        // request body can never carry a destination), so save first: the
        // test then exercises exactly what checkout will use.
        if (!(await form.trigger())) return;
        // getValues() is the RAW pre-coerce shape (e.g. networkPort is still
        // a string) — run the Zod schema to get the same coerced values
        // handleSubmit would deliver.
        const parsed = settingsSchema.safeParse(form.getValues());
        if (!parsed.success) return;
        try {
          const saved = await save(savePayload(parsed.data));
          finalCfg = saved.printerConfig ?? cfg;
          toast.success(t().settings.saved);
        } catch (err) {
          toastError(err); // maps Convex errors to friendly messages
          return;
        }
      }
      await printTestDoc(values.name || "POS", finalCfg);
      toast.success(t().settings.printerTestDone);
    } catch (err) {
      toastPrintError(err);
    } finally {
      setTesting(false);
    }
  }

  if (user == null || (shop === null && session)) {
    return <LoadingPage />;
  }

  if (user.role !== "owner") {
    return (
      <div className="flex w-full flex-col gap-6 p-4">
        <PageToolbar icon={Settings01Icon} title={t().nav.settings} />
        <Card>
          <CardHeader>
            <CardTitle>{t().settings.notOwnerTitle}</CardTitle>
            <CardDescription>{t().settings.notOwnerBody}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-6 p-4">
      <PageToolbar icon={Settings01Icon} title={t().nav.settings} />

      <FormProvider {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <Card>
            <CardHeader>
              <CardTitle>{t().settings.shopTitle}</CardTitle>
              <CardDescription>{t().settings.shopHint}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <FormInput name="name" label={t().settings.shopName} required maxLength={100} />
              <FormInput
                name="currency"
                label={t().settings.currency}
                hint={t().settings.currencyHint}
                required
                maxLength={8}
              />
              <FormCombobox
                name="timezone"
                label={t().settings.timezone}
                options={timezoneOptions}
                placeholder={t().settings.timezoneSearch}
                required
                className="sm:col-span-2"
              />
              <FormSelect
                name="language"
                label={t().settings.language}
                hint={t().settings.languageHint}
                options={[
                  { value: "en", label: "English" },
                  { value: "km", label: "ខ្មែរ" },
                ]}
              />
              <FormSwitch
                name="deliveryEnabled"
                label={t().settings.deliveryEnabled}
                hint={t().settings.deliveryHint}
              />
              <FormTextarea
                name="address"
                label={t().settings.address}
                hint={t().settings.addressHint}
                className="sm:col-span-2"
              />
              <FormInput
                name="exchangeRate"
                label={t().settings.exchangeRate}
                hint={t().settings.exchangeRateHint}
                required
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
              />
              <FormInput
                name="lowStockThreshold"
                label={t().settings.lowStockThreshold}
                hint={t().settings.lowStockThresholdHint}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
              />
              {/* The customer the POS preselects when the sale page opens. */}
              <FormCombobox
                name="defaultCustomerId"
                label={t().settings.defaultCustomer}
                hint={t().settings.defaultCustomerHint}
                options={[
                  {
                    value: DEFAULT_CUSTOMER_NONE,
                    label: t().sales.walkInCustomer,
                  },
                  ...customers
                    .filter((c) => !c.isWalkIn)
                    .map((c) => ({
                      value: c._id,
                      label: `${c.name}${c.phone ? ` · ${c.phone}` : ""}`,
                    })),
                ]}
                className="sm:col-span-2"
              />
            </CardContent>
          </Card>

          {/* T25 — the 80mm thermal printer for receipts and package labels.
              The whole card submits with the same form; the footer holds the
              submit (bottom-left, per convention) + the test-print action. */}
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>{t().settings.printerTitle}</CardTitle>
              <CardDescription>
                {t().settings.printerHint}
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t().settings.printerPaperHint}
                </span>
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <FormSelect
                name="printerType"
                label={t().settings.printerType}
                hint={t().settings.printerTypeHint}
                options={[
                  { value: "", label: t().settings.printerNone },
                  { value: "webusb", label: t().settings.printerWebUsb },
                  { value: "qz_tray", label: t().settings.printerQzTray },
                  { value: "network", label: t().settings.printerNetwork },
                ]}
                className="sm:col-span-2"
              />

              {printerType === "webusb" && (
                <>
                  <FormInput
                    name="vendorId"
                    label={t().settings.printerVendorId}
                    hint={t().settings.printerIdsHint}
                    maxLength={4}
                    placeholder="04B8"
                  />
                  <FormInput
                    name="productId"
                    label={t().settings.printerProductId}
                    maxLength={4}
                    placeholder="0202"
                  />
                  <div className="flex items-center gap-3 sm:col-span-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleScanUsb}
                      disabled={scanning || !usbSupported()}
                    >
                      <HugeiconsIcon
                        icon={UsbConnected01Icon}
                        strokeWidth={2}
                        className="size-4"
                      />
                      {t().settings.printerScan}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {t().settings.printerScanHint}
                    </p>
                  </div>
                </>
              )}

              {printerType === "qz_tray" && (
                <>
                  <FormInput
                    name="qzPrinterName"
                    label={t().settings.printerQzName}
                    hint={t().settings.printerQzNameHint}
                    maxLength={200}
                  />
                  <FormTextarea
                    name="qzCert"
                    label={t().settings.printerQzCert}
                    hint={t().settings.printerQzCertHint}
                    rows={4}
                    className="sm:col-span-2"
                  />
                </>
              )}

              {printerType === "network" && (
                <>
                  <FormInput
                    name="networkHost"
                    label={t().settings.printerNetworkHost}
                    hint={t().settings.printerNetworkHostHint}
                    maxLength={253}
                    placeholder="192.168.1.50"
                  />
                  <FormInput
                    name="networkPort"
                    label={t().settings.printerNetworkPort}
                    hint={t().settings.printerNetworkPortHint}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65535}
                    step={1}
                    placeholder="9100"
                  />
                </>
              )}
            </CardContent>
            <CardFooter className="border-t">
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={saving}>
                  {t().common.save}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => form.reset(shop ? shopToValues(shop) : DEFAULT_VALUES)}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
                  {t().common.cancel}
                </Button>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={handleTestPrint}
                disabled={testing}
                className="ml-auto"
              >
                <HugeiconsIcon icon={PrinterIcon} strokeWidth={2} className="size-4" />
                {t().settings.printerTest}
              </Button>
            </CardFooter>
          </Card>
        </form>
      </FormProvider>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>{t().settings.usersTitle}</CardTitle>
              <CardDescription>{t().settings.usersHint}</CardDescription>
            </div>
            <Button type="button" onClick={() => setAddStaffOpen(true)}>
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} className="size-4" />
              {t().settings.addStaff}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={usersPage?.page ?? []}
            persistKey="settings-users"
            loading={usersPage === undefined}
            totalCount={usersPage?.total}
            pageIndex={pageIndex}
            pageSize={pageSize}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPageIndex(0);
              setCursors([]);
            }}
            onPageChange={(direction) => {
              if (direction === "prev") {
                setPageIndex((i) => Math.max(0, i - 1));
              } else if (usersPage?.continueCursor) {
                setCursors((c) =>
                  c[pageIndex] === undefined ? [...c, usersPage.continueCursor] : c,
                );
                setPageIndex((i) => i + 1);
              }
            }}
            cardRender={(u) => (
              <Card>
                <CardHeader>
                  <CardTitle className={u.active ? "" : "text-muted-foreground line-through"}>
                    {u.name}
                  </CardTitle>
                  <CardDescription>{u.email}</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant={u.active ? "success" : "secondary"}>
                      {u.active ? t().settings.userActive : t().settings.userInactive}
                    </Badge>
                    <Badge variant={u.role === "owner" ? "default" : "secondary"}>
                      {u.role === "owner" ? t().common.roleOwner : t().common.roleStaff}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between">
                    <RoleSelect
                      userId={u._id}
                      role={u.role}
                      disabled={u._id === user._id || !u.active}
                    />
                    <UserRowActions
                      target={u}
                      selfId={user._id}
                      onResetPassword={setResetTarget}
                      onToggleActive={(target) =>
                        target.active
                          ? setDeactivateTarget(target)
                          : void activate(target)
                      }
                    />
                  </div>
                </CardContent>
              </Card>
            )}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t().settings.backupTitle}</CardTitle>
          <CardDescription>{t().settings.backupHint}</CardDescription>
        </CardHeader>
        <CardContent className="flex-row items-center justify-between">
          <Button type="button" onClick={downloadBackup} disabled={backingUp}>
            <HugeiconsIcon icon={Download01Icon} strokeWidth={2} className="size-4" />
            {t().settings.backupAction}
          </Button>
        </CardContent>
      </Card>

      {resetTarget ? (
        <ResetPasswordDialog target={resetTarget} onClose={() => setResetTarget(null)} />
      ) : null}
      {deactivateTarget ? (
        <DeactivateDialog
          target={deactivateTarget}
          onClose={() => setDeactivateTarget(null)}
        />
      ) : null}
      {addStaffOpen ? <AddStaffDialog onClose={() => setAddStaffOpen(false)} /> : null}
    </div>
  );
}
