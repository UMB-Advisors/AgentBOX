import { cn } from "@/lib/utils";

/** Combined / per-account segmented selector shared by the Home, Calendar, and
 *  Drive pages. Active = solid (brand) pill; inactive = ghost — matching the
 *  dashboard's existing active/inactive button treatment. Only render with 2+
 *  accounts. */
export function AccountSelector({
  accounts,
  view,
  onViewChange,
  disabled,
}: {
  accounts: string[];
  view: string;
  onViewChange: (view: string) => void;
  disabled?: boolean;
}) {
  const options = ["combined", ...accounts];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((opt) => {
        const active = view === opt;
        const label = opt === "combined" ? "Combined" : opt;
        return (
          <button
            key={opt}
            type="button"
            aria-pressed={active}
            title={opt === "combined" ? undefined : opt}
            onClick={() => {
              if (!active) onViewChange(opt);
            }}
            disabled={disabled}
            className={cn(
              "max-w-full truncate rounded-full px-3 py-1 text-xs font-medium normal-case tracking-normal transition-colors",
              active
                ? "bg-brand text-brand-foreground"
                : "border border-border text-text-secondary hover:bg-midground/5 hover:text-foreground",
              disabled && "cursor-default opacity-60",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** Tiny muted source-account chip for combined-view item rows. Shows the
 *  pre-@ local part with the full email as the title for hover. */
export function AccountTag({ account }: { account: string }) {
  if (!account) return null;
  const local = account.includes("@") ? account.split("@")[0] : account;
  return (
    <span title={account} className="shrink-0 text-[11px] text-text-tertiary">
      {local}
    </span>
  );
}
