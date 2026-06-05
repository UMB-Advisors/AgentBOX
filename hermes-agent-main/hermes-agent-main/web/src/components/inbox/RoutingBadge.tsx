// Operator-facing transparency about how a draft got its body: local vs cloud
// route, model id, and classifier confidence (+ a low-confidence hint on cloud
// fallbacks). Ported from mailbox-dashboard RoutingBadge (STAQPRO-331 #3),
// restyled to the hermes token vocabulary and decoupled from the mailbox
// category tables (display-only — the operator sees the actual confidence %).

/** Cloud fallbacks below this classifier confidence are flagged as a
 * safety-net route rather than a category match. */
const LOW_CONFIDENCE_FLOOR = 0.6;

function shortModel(model: string): string {
  if (model.startsWith("claude-haiku-")) return "haiku-4-5";
  if (model.startsWith("claude-sonnet-")) return "sonnet-4-6";
  if (model.startsWith("claude-opus-")) return "opus-4-8";
  return model;
}

export function RoutingBadge({
  draftSource,
  model,
  confidence,
}: {
  draftSource: string | null;
  model: string | null;
  confidence: number | string | null;
}) {
  if (!model && !draftSource) return null;
  const conf =
    confidence == null
      ? null
      : typeof confidence === "string"
        ? Number.parseFloat(confidence)
        : confidence;
  const isCloud = draftSource === "cloud" || draftSource === "cloud_haiku";
  const lowConf = isCloud && conf != null && conf < LOW_CONFIDENCE_FLOOR;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-mono text-[11px]"
      title={`${isCloud ? "Cloud" : "Local"} route${model ? ` · ${model}` : ""}${
        conf != null ? ` · classifier confidence ${Math.round(conf * 100)}%` : ""
      }`}
    >
      <span className={isCloud ? "font-semibold text-primary" : "font-semibold text-success"}>
        {isCloud ? "Cloud" : "Local"}
      </span>
      {model && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{shortModel(model)}</span>
        </>
      )}
      {conf != null && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">conf {Math.round(conf * 100)}%</span>
        </>
      )}
      {lowConf && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-warning">low confidence fallback</span>
        </>
      )}
    </span>
  );
}
