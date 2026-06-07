export function ClassificationChip({
  classification,
  confidence,
}: {
  classification: string | null;
  confidence: string | null;
}) {
  if (!classification) return null;

  const conf = confidence != null ? parseFloat(confidence) : null;
  const palette =
    conf == null
      ? 'border-border bg-bg-surface text-ink-muted'
      : conf >= 0.85
        ? 'border-accent-green/40 bg-accent-green/10 text-accent-green'
        : conf >= 0.6
          ? 'border-accent-orange/40 bg-accent-orange/10 text-accent-orange'
          : 'border-accent-red/40 bg-accent-red/10 text-accent-red';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px] ${palette}`}
    >
      <span>{classification}</span>
      {conf != null && <span className="text-ink-dim">{Math.round(conf * 100)}%</span>}
    </span>
  );
}
