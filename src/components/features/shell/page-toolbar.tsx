import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { ReactNode } from "react";

// Page-level toolbar, rendered by each page directly above its table or
// listing: feature icon + page title on the left, the primary action button
// and the filter area on the right of the same row (per the UI conventions
// in AGENTS.md). The GLOBAL header (POS, theme, language, profile) is the
// AppHeader rendered once by the app shell — never duplicated here.

type PageToolbarProps = {
  /** Feature icon (hugeicons data object) shown before the title. */
  icon?: IconSvgElement;
  title: string;
  /** Primary action button(s) and filters — right-aligned on the same row. */
  children?: ReactNode;
};

export function PageToolbar({ icon: Icon, title, children }: PageToolbarProps) {
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-2 border-b px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {Icon ? (
          <HugeiconsIcon
            icon={Icon}
            strokeWidth={2}
            className="size-5 shrink-0 text-muted-foreground"
          />
        ) : null}
        <h1 className="truncate font-heading text-lg font-semibold">{title}</h1>
      </div>
      {children ? (
        <div className="ms-auto flex flex-wrap items-center gap-2">{children}</div>
      ) : null}
    </div>
  );
}
