"use client";

import {
  Download01Icon,
  FileUploadIcon,
  WarehouseIcon,
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

import { parseOpeningStockRows } from "@/lib/import-utils";
import type { OpeningStockRow } from "@/lib/import-utils";

// Opening Stock page — upload a CSV/XLSX to set opening stock for existing
// products. The system looks up variants by product name + size + color and
// writes stockLedger rows to reach the target quantity.

export default function OpeningStockPage() {
  const user = useCurrentUser();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<OpeningStockRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ count: number } | null>(null);

  const importMutation = useMutation(api.imports.importOpeningStock);

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
          setErrors([t().openingStock.noFile]);
          setPreview([]);
          return;
        }

        const { valid, errors: parseErrors } = parseOpeningStockRows(rows);
        setPreview(valid);
        setErrors(parseErrors);
      } catch {
        setErrors([t().openingStock.invalidFile]);
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
      setResult({ count: res.count });
      if (res.errors.length > 0) {
        setErrors(res.errors);
      }
      toast.success(
        t().openingStock.done.replace("{count}", String(res.count)),
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
    const labels = t().openingStock;
    const rows: (string | number)[][] = [
      [
        labels.colProductName,
        labels.colSize,
        labels.colColor,
        labels.colQty,
        labels.colNote,
      ],
      ["Polka-dot shirt", "S", "", 10, "Initial stock"],
      ["Polka-dot shirt", "M", "", 15, ""],
      ["Polka-dot shirt", "L", "", 8, ""],
      ["Floral dress", "S", "Red", 5, ""],
      ["Floral dress", "M", "Blue", 12, ""],
      ["Basic tee", "XL", "", 20, "From supplier ABC"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [
      { wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 10 }, { wch: 25 },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, labels.sampleSheet);
    XLSX.writeFile(wb, "opening-stock-sample.xlsx");
  }

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={WarehouseIcon} title={t().openingStock.title}>
        <Button type="button" variant="outline" onClick={downloadSample}>
          <HugeiconsIcon icon={Download01Icon} strokeWidth={2} className="size-4" />
          {t().openingStock.downloadSample}
        </Button>
      </PageToolbar>

      <div className="flex flex-col gap-4 p-4">
        <p className="text-sm text-muted-foreground">
          {t().openingStock.hint}
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
              {t().openingStock.done.replace("{count}", String(result.count))}
            </CardContent>
          </Card>
        )}

        {/* Preview table */}
        {preview.length > 0 && (
          <Card>
            <CardHeader className="flex-row items-center justify-between pb-2">
              <div>
                <CardTitle className="text-base">
                  {t().openingStock.previewTitle}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {t().openingStock.previewHint} ({preview.length} entries)
                </p>
              </div>
              <Button onClick={handleImport} disabled={importing}>
                {importing
                  ? t().openingStock.processing
                  : t().openingStock.importBtn}
              </Button>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-start text-xs font-medium text-muted-foreground">
                    <th className="pb-2 pe-3 text-start">#</th>
                    <th className="pb-2 pe-3 text-start">{t().openingStock.colProductName}</th>
                    <th className="pb-2 pe-3 text-start">{t().openingStock.colSize}</th>
                    <th className="pb-2 pe-3 text-start">{t().openingStock.colColor}</th>
                    <th className="pb-2 pe-3 text-end">{t().openingStock.colQty}</th>
                    <th className="pb-2 pe-3 text-start">{t().openingStock.colNote}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pe-3 text-muted-foreground">{i + 1}</td>
                      <td className="py-2 pe-3 font-medium">{row.productName}</td>
                      <td className="py-2 pe-3">{row.size}</td>
                      <td className="py-2 pe-3">{row.color || "—"}</td>
                      <td className="py-2 pe-3 text-end font-mono tabular-nums">
                        {row.qty}
                      </td>
                      <td className="py-2 pe-3 text-muted-foreground">{row.note ?? "—"}</td>
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
