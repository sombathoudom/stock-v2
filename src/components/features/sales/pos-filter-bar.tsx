"use client";

import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "convex/react";

import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCurrentUser } from "@/hooks/use-current-user";
import { t } from "@/lib/utils";

// POS v4 — the product filters live in the PAGE HEADER ("title + customer,
// category chips + size select + search"). Presentational only: the page
// owns the persisted values (usePersistentState) so its Reset button can
// clear them; this bar fetches the filter options (sizes, categories) and
// renders the controls: search box, category as a grid of toggle chips,
// size as a select box (sizes arrive sorted smallest first).

/** Sentinel Select value for "All sizes" ("" in Base UI = no value). */
const ALL = "__all__";

type Props = {
  search: string;
  onSearch: (value: string) => void;
  sizeFilter: string;
  onSizeFilter: (value: string) => void;
  categoryFilter: string;
  onCategoryFilter: (value: string) => void;
};

export function PosFilterBar({
  search,
  onSearch,
  sizeFilter,
  onSizeFilter,
  categoryFilter,
  onCategoryFilter,
}: Props) {
  const user = useCurrentUser();
  const sizes = useQuery(api.pos.listSizes, user == null ? "skip" : {});
  const categories = useQuery(api.pos.listCategories, user == null ? "skip" : {});

  const hasFilters = search !== "" || sizeFilter !== "" || categoryFilter !== "";
  const clearAll = () => {
    onSearch("");
    onSizeFilter("");
    onCategoryFilter("");
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Search, category filter, clear, and the size chips — ONE wrapping
          flex row, so the whole header sits on a single line. */}
      <div className="min-w-40 flex-1 sm:max-w-56">
        <InputGroup>
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder={t().sales.searchProducts}
            aria-label={t().sales.searchProducts}
          />
        </InputGroup>
      </div>

      {/* Category — a grid of toggle chips (tap again to clear). */}
      {categories !== undefined && categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <Button
            type="button"
            size="sm"
            variant={categoryFilter === "" ? "default" : "outline"}
            className="h-7 px-2 text-xs"
            onClick={() => onCategoryFilter("")}
          >
            {t().sales.allCategories}
          </Button>
          {categories.map((c) => (
            <Button
              key={c._id}
              type="button"
              size="sm"
              variant={categoryFilter === c._id ? "default" : "outline"}
              className="h-7 px-2 text-xs"
              onClick={() =>
                onCategoryFilter(categoryFilter === c._id ? "" : c._id)
              }
            >
              {c.name}
            </Button>
          ))}
        </div>
      )}

      {hasFilters && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 px-2 text-xs text-destructive hover:text-destructive"
          onClick={clearAll}
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
          {t().sales.clearFilters}
        </Button>
      )}

      {/* Size — a select box (sizes arrive already sorted smallest first). */}
      {sizes !== undefined && sizes.length > 0 && (
        <Select
          value={sizeFilter || ALL}
          // Base UI shows the RAW value in the trigger without this map.
          items={{
            [ALL]: t().sales.allSizes,
            ...Object.fromEntries(sizes.map((s) => [s, s])),
          }}
          onValueChange={(v) => onSizeFilter(v === ALL ? "" : (v ?? ""))}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t().sales.allSizes}</SelectItem>
            {sizes.map((size) => (
              <SelectItem key={size} value={size}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
