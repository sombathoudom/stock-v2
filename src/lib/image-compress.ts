// Client-side image compression before Convex storage upload. Staff photos
// come straight from phone cameras (often 3–8 MB); every screen renders them
// as thumbnails, so uploading originals wastes bandwidth and slows first
// paint everywhere. We downscale to a max edge and re-encode as WebP (JPEG
// fallback) — the result never replaces the original when it isn't smaller,
// and anything we can't process passes through untouched so uploads NEVER
// break because of this optimization.

const MAX_EDGE = 1024;
const WEBP_QUALITY = 0.82;
const JPEG_QUALITY = 0.85;

/** Replace the extension to match the re-encoded type ("photo.HEIC" →
 * "photo.webp"). */
function renameWithExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${extension}`;
}

function bitmapSize(bitmap: ImageBitmap): { width: number; height: number } {
  return { width: bitmap.width, height: bitmap.height };
}

async function encode(
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<Blob | null> {
  // OffscreenCanvas covers Chromium/Firefox/Safari 16.4+; the DOM canvas is
  // the fallback for older Safari.
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(source, 0, 0, width, height);
    const webp = await canvas.convertToBlob({ type: "image/webp", quality: WEBP_QUALITY });
    if (webp.type === "image/webp") return webp;
    return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  }
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(source, 0, 0, width, height);
  const toBlob = (
    type: string,
    quality: number,
  ): Promise<Blob | null> =>
    new Promise((resolve) => canvas.toBlob(resolve, type, quality));
  const webp = await toBlob("image/webp", WEBP_QUALITY);
  if (webp && webp.type === "image/webp") return webp;
  return toBlob("image/jpeg", JPEG_QUALITY);
}

/**
 * Downscale + re-encode an image File. Returns the ORIGINAL file unchanged
 * when it's not an image, is an animated GIF, can't be decoded, or when the
 * re-encode wouldn't actually save bytes.
 */
export async function compressImage(file: File): Promise<File> {
  const passthrough = (): File => file;
  if (!file.type.startsWith("image/") || file.type === "image/gif") {
    return passthrough();
  }
  try {
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = bitmapSize(bitmap);
      const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));

      const blob = await encode(bitmap, targetWidth, targetHeight);
      if (!blob || blob.size >= file.size) return passthrough();

      const extension = blob.type === "image/webp" ? "webp" : "jpg";
      const contentType = blob.type === "image/webp" ? "image/webp" : "image/jpeg";
      return new File([blob], renameWithExtension(file.name, extension), {
        type: contentType,
        lastModified: Date.now(),
      });
    } finally {
      bitmap.close();
    }
  } catch {
    // Undecodable or environment without the needed APIs — upload as-is
    // rather than failing the user's action.
    return passthrough();
  }
}
