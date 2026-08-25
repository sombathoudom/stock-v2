import { notFound } from "next/navigation";

import { PageToolbar } from "@/components/features/shell/page-toolbar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { recommendedReports } from "@/config/reports";
import { t } from "@/lib/utils";

export default async function RecommendedReportPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const report = recommendedReports.find((item) => item.slug === slug);
  if (!report || !report.descriptionKey) notFound();

  return (
    <div className="flex w-full flex-col">
      <PageToolbar icon={report.icon} title={t().reports[report.labelKey]} />
      <div className="p-4">
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{t().reports[report.labelKey]}</CardTitle>
              <Badge variant="secondary">{t().common.comingSoon}</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t().reports[report.descriptionKey]}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
