import { ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { diffLines, diffStats, type DiffLine } from "@/lib/line-diff";

// Shows the operator the changes they made to a draft: the LLM-original body
// (``original_draft_body``, snapshotted on first edit) vs the current body.
// Diff computed lazily on first expand. Renders nothing when original is null
// or identical to current. Ported from mailbox-dashboard EditDiff (STAQPRO-331 #4).

export function EditDiff({
  original,
  current,
}: {
  original: string | null;
  current: string;
}) {
  const [open, setOpen] = useState(false);

  const diff = useMemo(() => {
    if (original == null || original === current) return null;
    return diffLines(original, current);
  }, [original, current]);

  if (!diff) return null;
  const stats = diffStats(diff);
  if (stats.added === 0 && stats.removed === 0) return null;

  return (
    <section className="border border-border bg-background/40">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-xs text-muted-foreground"
      >
        <span>Show changes</span>
        <span className="text-success">+{stats.added}</span>
        <span className="text-destructive">-{stats.removed}</span>
        <ChevronDown
          size={14}
          className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border px-3 py-2">
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
            {diff.map((line, idx) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: stable on memoized output
              <DiffRow key={idx} line={line} />
            ))}
          </pre>
        </div>
      )}
    </section>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  if (line.op === "equal") {
    return (
      <span className="block text-muted-foreground">
        {"  "}
        {line.text || " "}
        {"\n"}
      </span>
    );
  }
  if (line.op === "add") {
    return (
      <span className="block bg-success/10 text-success">
        {"+ "}
        {line.text || " "}
        {"\n"}
      </span>
    );
  }
  return (
    <span className="block bg-destructive/10 text-destructive">
      {"- "}
      {line.text || " "}
      {"\n"}
    </span>
  );
}
