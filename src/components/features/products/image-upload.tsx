"use client";

import { ImageAdd01Icon, Image01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "convex/react";
import { useId, useState } from "react";
import { useController, useFormContext } from "react-hook-form";

import { api } from "@convex/_generated/api";
import { Button, buttonVariants } from "@/components/ui/button";
import { toast } from "sonner";
import { cn, imageUrl, t, toastError } from "@/lib/utils";
import { compressImage } from "@/lib/image-compress";
import { FormField } from "@/components/features/forms/form-field";

// Product photo upload via Convex file storage. The upload URL is issued by
// an AUTHENTICATED mutation, so only signed-in staff can push bytes. The
// file is posted immediately (the URL is short-lived) and the storage id
// lives in the form under `name`; a preview renders from /getImage.
//
// Photos are downscaled/re-encoded client-side before upload (phone cameras
// produce multi-MB files that every screen renders as thumbnails) — see
// lib/image-compress. The 10 MB cap applies to the COMPRESSED result; the
// original may be larger.
//
// The visible "button" is a <label> for the sr-only file input: the browser
// opens the OS file picker natively, with no JS click indirection. Some
// browsers swallow programmatic .click() on display:none inputs, leaving a
// dead button — native label activation works everywhere.

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB (after compression)

export type ImageUploadProps = {
  name: string;
  label: string;
  hint?: string;
  className?: string;
};

export function ImageUpload({ name, label, hint, className }: ImageUploadProps) {
  const { control } = useFormContext();
  const { field } = useController({ control, name });
  const generateUploadUrl = useMutation(api.products.generateUploadUrl);
  const [busy, setBusy] = useState(false);
  const inputId = useId();

  const storageId = (field.value as string | undefined) ?? undefined;

  async function onFile(file: File) {
    if (!file.type.startsWith("image/")) {
      toast.error(t().products.invalidImage);
      return;
    }
    setBusy(true);
    try {
      // Downscale + re-encode before the size cap so big phone photos still
      // upload (compressed) instead of being rejected outright.
      const compressed = await compressImage(file);
      if (compressed.size > MAX_BYTES) {
        toast.error(t().products.invalidImage);
        return;
      }
      // Authenticated short-lived URL — post immediately.
      const url = await generateUploadUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": compressed.type },
        body: compressed,
      });
      if (!res.ok) throw new Error(`Upload failed with status ${res.status}`);
      const { storageId: newStorageId } = (await res.json()) as { storageId: string };
      field.onChange(newStorageId);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormField label={label} hint={hint} className={className}>
      {/* The input sits first so `peer` focus styles reach the labels below;
          sr-only keeps it in the accessibility tree and keyboard-focusable. */}
      <input
        id={inputId}
        type="file"
        accept="image/*"
        className="peer sr-only"
        aria-label={t().products.uploadPhoto}
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
          e.target.value = ""; // same file can be re-picked
        }}
      />
      <div className="flex flex-col gap-2">
        {storageId ? (
          <>
            {/* Fixed square preview — object-contain shows the whole image
                clearly (no stretching or cropping) on a neutral backdrop. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl(storageId)}
              alt={t().products.photo}
              className="size-40 rounded-md border bg-muted object-contain"
            />
            <div className="flex gap-2">
              <label
                htmlFor={inputId}
                className={cn(
                  buttonVariants({ variant: "outline", size: "sm" }),
                  "cursor-pointer peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
                  busy && "pointer-events-none opacity-50",
                )}
              >
                <HugeiconsIcon icon={Image01Icon} strokeWidth={2} className="size-4" />
                {t().products.replacePhoto}
              </label>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => field.onChange(undefined)}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
                {t().products.removePhoto}
              </Button>
            </div>
          </>
        ) : (
          <label
            htmlFor={inputId}
            className={cn(
              buttonVariants({ variant: "outline" }),
              "w-fit cursor-pointer peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50",
              busy && "pointer-events-none opacity-50",
            )}
          >
            <HugeiconsIcon icon={ImageAdd01Icon} strokeWidth={2} className="size-4" />
            {busy ? t().common.loading : t().products.uploadPhoto}
          </label>
        )}
      </div>
    </FormField>
  );
}
