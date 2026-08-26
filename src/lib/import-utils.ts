// Shared parsing utilities for file imports (products + opening stock).
// Used client-side for preview; the server re-validates everything.

export type ImportProductRow = {
  name: string;
  category?: string;
  defaultPrice: number;
  defaultCost: number;
  hasColors: boolean;
  sizes: string[];
  colors: string[];
  description?: string;
  code?: string;
};

export type OpeningStockRow = {
  productName: string;
  size: string;
  color: string;
  qty: number;
  note?: string;
};

function parseString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value == null) return "";
  return String(value).trim();
}

function parseCents(value: unknown): number {
  if (typeof value === "number") {
    return Math.round(value * 100);
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,]/g, "").trim();
    const num = Number(cleaned);
    if (!Number.isFinite(num)) throw new Error("Invalid money");
    return Math.round(num * 100);
  }
  throw new Error("Invalid money");
}

function parseBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    return lower === "true" || lower === "yes" || lower === "1";
  }
  if (typeof value === "number") return value === 1;
  return false;
}

function cleanTags(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 20)
    .slice(0, 30);
}

export function parseProductRows(rawRows: Record<string, unknown>[]): {
  valid: ImportProductRow[];
  errors: string[];
} {
  const valid: ImportProductRow[] = [];
  const errors: string[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const rowNum = i + 2;
    try {
      const name = parseString(
        row["Product Name"] ?? row["productName"] ?? row["name"],
      );
      if (!name) {
        errors.push(`Row ${rowNum}: missing product name`);
        continue;
      }

      const sizesRaw = parseString(row["Sizes"] ?? row["sizes"]);
      const sizes = cleanTags(sizesRaw);
      if (sizes.length === 0) {
        errors.push(`Row ${rowNum}: missing sizes`);
        continue;
      }

      const hasColors = parseBool(row["Has Colors"] ?? row["hasColors"]);
      const colorsRaw = parseString(row["Colors"] ?? row["colors"]);
      const colors = hasColors ? cleanTags(colorsRaw) : [];
      if (hasColors && colors.length === 0) {
        errors.push(`Row ${rowNum}: has colors but no colors listed`);
        continue;
      }

      const defaultPrice = parseCents(
        row["Default Price"] ?? row["defaultPrice"] ?? row["price"],
      );
      const defaultCost = parseCents(
        row["Default Cost"] ?? row["defaultCost"] ?? row["cost"],
      );

      const category =
        parseString(row["Category"] ?? row["category"]) || undefined;
      const description =
        parseString(row["Description"] ?? row["description"]) || undefined;
      const code = parseString(row["Code"] ?? row["code"]) || undefined;

      valid.push({
        name,
        category,
        defaultPrice,
        defaultCost,
        hasColors,
        sizes,
        colors,
        description,
        code,
      });
    } catch {
      errors.push(`Row ${rowNum}: invalid data`);
    }
  }

  return { valid, errors };
}

export function parseOpeningStockRows(rawRows: Record<string, unknown>[]): {
  valid: OpeningStockRow[];
  errors: string[];
} {
  const valid: OpeningStockRow[] = [];
  const errors: string[] = [];

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const rowNum = i + 2;
    try {
      const productName = parseString(
        row["Product Name"] ?? row["productName"] ?? row["name"],
      );
      if (!productName) {
        errors.push(`Row ${rowNum}: missing product name`);
        continue;
      }

      const size = parseString(row["Size"] ?? row["size"]);
      if (!size) {
        errors.push(`Row ${rowNum}: missing size`);
        continue;
      }

      const color = parseString(row["Color"] ?? row["color"]);
      const note = parseString(row["Note"] ?? row["note"]) || undefined;

      let qty: number;
      const rawQty = row["Quantity"] ?? row["qty"] ?? row["quantity"];
      if (typeof rawQty === "number") {
        qty = rawQty;
      } else if (typeof rawQty === "string") {
        qty = Number(rawQty.replace(/,/g, "").trim());
      } else {
        errors.push(`Row ${rowNum}: invalid quantity`);
        continue;
      }
      if (!Number.isFinite(qty) || qty < 0 || !Number.isInteger(qty)) {
        errors.push(
          `Row ${rowNum}: quantity must be a non-negative whole number`,
        );
        continue;
      }

      valid.push({ productName, size, color, qty, note });
    } catch {
      errors.push(`Row ${rowNum}: invalid data`);
    }
  }

  return { valid, errors };
}
