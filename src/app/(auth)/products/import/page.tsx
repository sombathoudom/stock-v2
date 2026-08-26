"use client";

import {
  Download01Icon,
  FileUploadIcon,
  Shirt01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "convex/react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import * as XLSX from "xlsx";

import { api } from "@convex/_generated/api";
import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrentUser } from "@/hooks/use-current-user";
import { t, toastError } from "@/lib/utils";

import { parseProductRows } from "@/lib/import-utils";
import type { ImportProductRow } from "@/lib/import-utils";

// Import Products page — upload a CSV/XLSX to bulk-create products with
// their sizes and colors. Download a sample file to see the expected format.

export default function ImportProductsPage() {
  const user = useCurrentUser();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<ImportProductRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{
    created: number;
    skipped: number;
  } | null>(null);

  const importMutation = useMutation(api.imports.importProducts);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setResult(null);
    setErrors([]);

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);

        if (rows.length === 0) {
          setErrors([t().importProducts.noFile]);
          setPreview([]);
          return;
        }

        const { valid, errors: parseErrors } = parseProductRows(rows);
        setPreview(valid);
        setErrors(parseErrors);
      } catch {
        setErrors([t().importProducts.invalidFile]);
        setPreview([]);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  async function handleImport() {
    if (preview.length === 0) return;
    setImporting(true);
    try {
      const res = await importMutation({ rows: preview });
      setResult({ created: res.created, skipped: res.skipped });
      if (res.errors.length > 0) {
        setErrors(res.errors);
      }
      toast.success(
        t().importProducts.done
          .replace("{created}", String(res.created))
          .replace("{skipped}", String(res.skipped)),
      );
      setPreview([]);
      if (fileRef.current) fileRef.current.value = "";
    } catch (err) {
      toastError(err);
    } finally {
      setImporting(false);
    }
  }

  function downloadSample() {
    const labels = t().importProducts;
    const rows: (string | number | boolean)[][] = [
      [
        labels.colProductName,
        labels.colCategory,
        labels.colDefaultPrice,
        labels.colDefaultCost,
        labels.colHasColors,
        labels.colSizes,
        labels.colColors,
        labels.colDescription,
        labels.colCode,
      ],
      ["Polka-dot shirt", "Shirts", 12.5, 5.0, false, "S,M,L,XL", "", "A nice shirt", "SH001"],
      ["Floral dress", "Dresses", 25.0, 10.0, true, "S,M,L", "Red,Blue,White", "", ""],
      ["Basic tee", "", 8.0, 3.0, false, "M,L,XL,2XL", "", "", "TEE01"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [
      { wch: 20 }, { wch: 15 }, { wch: 14 }, { wch: 14 },
      { wch: 10 }, { wch: 20 }, { wch: 20 }, { wch: 25 }, { wch: 10 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, labels.sampleSheet);
    XLSX.writeFile(wb, "import-products-sample.xlsx");
  }

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={Shirt01Icon} title={t().importProducts.title}>
        <Button type="button" variant="outline" onClick={downloadSample}>
          <HugeiconsIcon icon={Download01Icon} strokeWidth={2} className="size-4" />
          {t().importProducts.downloadSample}
        </Button>
      </PageToolbar>

      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          {t().importProducts.hint}
        </p>

        {/* Upload area */}
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-8">
            <HugeiconsIcon
              icon={FileUploadIcon}
              strokeWidth={1.5}
              className="size-10 text-muted-foreground"
            />
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              onChange={handleFile}
              className="block text-sm file:me-2 file:rounded-md file:border file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-muted/80"
            />
          </CardContent>
        </Card>

        {/* Errors */}
        {errors.length > 0 && (
          <Card className="border-destructive/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-destructive">
                {errors.length} {errors.length === 1 ? "issue" : "issues"}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
                {errors.slice(0, 20).map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
                {errors.length > 20 && (
                  <li>…and {errors.length - 20} more</li>
                )}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Result */}
        {result && (
          <Card className="border-green-500/50">
            <CardContent className="py-3 text-sm font-medium text-green-600">
              {t().importProducts.done
                .replace("{created}", String(result.created))
                .replace("{skipped}", String(result.skipped))}
            </CardContent>
          </Card>
        )}

        {/* Preview table */}
        {preview.length > 0 && (
          <Card>
            <CardHeader className="flex-row items-center justify-between pb-2">
              <div>
                <CardTitle className="text-base">
                  {t().importProducts.previewTitle}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {t().importProducts.previewHint} ({preview.length} products)
                </p>
              </div>
              <Button onClick={handleImport} disabled={importing}>
                {importing
                  ? t().importProducts.processing
                  : t().importProducts.importBtn}
              </Button>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-start text-xs font-medium text-muted-foreground">
                    <th className="pb-2 pe-3 text-start">#</th>
                    <th className="pb-2 pe-3 text-start">{t().importProducts.colProductName}</th>
                    <th className="pb-2 pe-3 text-start">{t().importProducts.colCategory}</th>
                    <th className="pb-2 pe-3 text-end">{t().importProducts.colDefaultPrice}</th>
                    <th className="pb-2 pe-3 text-end">{t().importProducts.colDefaultCost}</th>
                    <th className="pb-2 pe-3 text-start">{t().importProducts.colSizes}</th>
                    <th className="pb-2 pe-3 text-start">{t().importProducts.colColors}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pe-3 text-muted-foreground">{i + 1}</td>
                      <td className="py-2 pe-3 font-medium">{row.name}</td>
                      <td className="py-2 pe-3 text-muted-foreground">{row.category ?? "—"}</td>
                      <td className="py-2 pe-3 text-end font-mono tabular-nums">
                        ${(row.defaultPrice / 100).toFixed(2)}
                      </td>
                      <td className="py-2 pe-3 text-end font-mono tabular-nums">
                        ${(row.defaultCost / 100).toFixed(2)}
                      </td>
                      <td className="py-2 pe-3">{row.sizes.join(", ")}</td>
                      <td className="py-2 pe-3">{row.hasColors ? row.colors.join(", ") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
