import { describe, expect, test } from "vitest";

import { compressImage } from "./image-compress";

function fileOf(name: string, type: string, size = 1000): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

describe("compressImage", () => {
  test("passes non-images through untouched", async () => {
    const pdf = fileOf("invoice.pdf", "application/pdf");
    expect(await compressImage(pdf)).toBe(pdf);
  });

  test("passes animated GIFs through to preserve animation", async () => {
    const gif = fileOf("loop.gif", "image/gif");
    expect(await compressImage(gif)).toBe(gif);
  });

  test("returns the original when decoding is unavailable in this environment", async () => {
    // The test DOM has no real image decoder / canvas — the helper must
    // degrade gracefully instead of throwing, so uploads never break.
    const png = fileOf("photo.png", "image/png");
    const result = await compressImage(png);
    expect(result).toBe(png);
    expect(result.type).toBe("image/png");
  });
});
