#!/usr/bin/env python3
"""Score MAIL-05 classifier against the labeled corpus.

Designed to run ON the Jetson (so postgres / dashboard / ollama are localhost).

Usage:
  python3 scripts/score-classifier.py [--source db|gmail|all] [--limit N]

Reads:  scripts/heron-labs-corpus.sample.json
Writes: scripts/heron-labs-corpus.scored-YYYY-MM-DD.csv
        + per-category metrics + confusion matrix to stdout
"""

import argparse
import csv
import json
import os
import subprocess
import sys
import time
import urllib.request
from collections import Counter, defaultdict
from datetime import date

CORPUS_PATH = os.path.join(os.path.dirname(__file__), "heron-labs-corpus.sample.json")
DASH = "http://localhost:3001/dashboard/api/internal"
OLLAMA = "http://localhost:11434/api/generate"
PG_CONTAINER = os.environ.get("PG_CONTAINER", "mailbox-postgres-1")
PG_DB = os.environ.get("POSTGRES_DB", "mailbox")
PG_USER = os.environ.get("POSTGRES_USER", "mailbox")

LABELS = ["inquiry", "reorder", "scheduling", "follow_up",
          "internal", "spam_marketing", "escalate", "unknown"]

# Mirror lib/classification/prompt.ts routeFor() — keep in sync with D-01/D-02.
LOCAL_CONFIDENCE_FLOOR = 0.75
LOCAL_CATEGORIES = {"reorder", "scheduling", "follow_up", "internal"}


def route_for(category, confidence):
    if category == "spam_marketing":
        return "drop"
    if confidence < LOCAL_CONFIDENCE_FLOOR:
        return "cloud"
    if category in LOCAL_CATEGORIES:
        return "local"
    return "cloud"


def http_post(url, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def fetch_all_db_bodies(ids):
    """Fetch all batch-1 bodies in one docker exec call -> {id: body}."""
    if not ids:
        return {}
    id_list = ",".join(str(int(i)) for i in ids)
    sql = (
        "SELECT json_agg(json_build_object('id', id, 'body', body))::text "
        f"FROM mailbox.inbox_messages WHERE id IN ({id_list})"
    )
    out = subprocess.check_output([
        "docker", "exec", "-i", PG_CONTAINER,
        "psql", "-U", PG_USER, "-d", PG_DB, "-At", "-c", sql,
    ], text=True)
    rows = json.loads(out.strip()) or []
    return {str(r["id"]): (r["body"] or "") for r in rows}


def classify(from_addr, subject, body):
    p = http_post(f"{DASH}/classification-prompt",
                  {"from": from_addr, "subject": subject, "body": body or ""})
    t0 = time.time()
    r = http_post(OLLAMA, {"model": p["model"], "prompt": p["prompt"],
                           "stream": False, "options": {"temperature": 0}})
    latency_ms = int((time.time() - t0) * 1000)
    raw = r.get("response", "")
    n = http_post(f"{DASH}/classification-normalize",
                  {"raw": raw, "from": from_addr, "to": ""})
    return {
        "category": n["category"],
        "confidence": n.get("confidence", 0),
        "json_parse_ok": n.get("json_parse_ok", False),
        "preclass_applied": n.get("preclass_applied", False),
        "preclass_source": n.get("preclass_source"),
        "latency_ms": latency_ms,
        "raw": raw[:300],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["db", "gmail", "all"], default="db",
                    help="db = batch 1 (full bodies); gmail = batches 2-4 (snippet only); all")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--bodies-only", action="store_true",
                    help="Only score rows where we have a full body (DB or fetched gmail)")
    args = ap.parse_args()

    with open(CORPUS_PATH) as f:
        corpus = json.load(f)
    if args.source != "all":
        corpus = [r for r in corpus if r["source"] == args.source]

    # Load fetched gmail bodies if present
    bodies_path = os.path.join(os.path.dirname(__file__), "corpus-bodies.json")
    gmail_bodies = {}
    if os.path.exists(bodies_path):
        with open(bodies_path) as f:
            for tid, v in json.load(f).items():
                if "body" in v:
                    gmail_bodies[tid] = v["body"]
        print(f"Loaded {len(gmail_bodies)} gmail bodies from corpus-bodies.json",
              file=sys.stderr)

    if args.bodies_only:
        corpus = [r for r in corpus
                  if r["source"] == "db" or r["id"] in gmail_bodies]
        print(f"Filtered to {len(corpus)} rows with full bodies", file=sys.stderr)
    if args.limit:
        corpus = corpus[: args.limit]

    print(f"Scoring {len(corpus)} rows (source={args.source})", file=sys.stderr)

    db_ids = [r["id"] for r in corpus if r["source"] == "db"]
    body_cache = fetch_all_db_bodies(db_ids)
    print(f"Fetched {len(body_cache)} bodies from DB", file=sys.stderr)
    out_path = os.path.join(os.path.dirname(__file__),
                            f"heron-labs-corpus.scored-{date.today().isoformat()}.csv")
    results = []
    with open(out_path, "w", newline="") as out:
        w = csv.writer(out)
        w.writerow(["id", "source", "from_addr", "subject", "true_label",
                    "pred_label", "confidence", "json_parse_ok", "latency_ms",
                    "match", "preclass_applied", "preclass_source"])
        for i, row in enumerate(corpus, 1):
            if row["source"] == "db":
                body = body_cache.get(str(row["id"])) or row["snippet"]
            else:
                body = gmail_bodies.get(row["id"]) or row["snippet"]
            try:
                res = classify(row["from_addr"], row["subject"], body)
            except Exception as e:
                print(f"[{i}/{len(corpus)}] {row['id']}: ERROR {e}", file=sys.stderr)
                continue
            match = res["category"] == row["label"]
            results.append({**row, **res, "match": match})
            w.writerow([row["id"], row["source"], row["from_addr"], row["subject"],
                        row["label"], res["category"], res["confidence"],
                        res["json_parse_ok"], res["latency_ms"], match,
                        res["preclass_applied"], res["preclass_source"] or ""])
            print(f"[{i}/{len(corpus)}] {row['id']:>20} true={row['label']:14s} "
                  f"pred={res['category']:14s} {'OK' if match else 'MISS'} "
                  f"({res['latency_ms']}ms)", file=sys.stderr)

    print(f"\nWrote {out_path}", file=sys.stderr)

    # Metrics
    print("\n=== Per-category metrics ===")
    print(f"{'category':16s} {'support':>7s} {'preds':>5s} {'TP':>3s} "
          f"{'FP':>3s} {'FN':>3s} {'prec':>6s} {'recall':>6s} {'F1':>6s}")
    for label in LABELS:
        tp = sum(1 for r in results if r["label"] == label and r["category"] == label)
        fp = sum(1 for r in results if r["label"] != label and r["category"] == label)
        fn = sum(1 for r in results if r["label"] == label and r["category"] != label)
        support = sum(1 for r in results if r["label"] == label)
        preds = sum(1 for r in results if r["category"] == label)
        prec = tp / (tp + fp) if (tp + fp) else 0
        rec = tp / (tp + fn) if (tp + fn) else 0
        f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0
        print(f"{label:16s} {support:>7d} {preds:>5d} {tp:>3d} {fp:>3d} {fn:>3d} "
              f"{prec:>6.2f} {rec:>6.2f} {f1:>6.2f}")

    overall_acc = sum(1 for r in results if r["match"]) / len(results) if results else 0
    avg_latency = sum(r["latency_ms"] for r in results) / len(results) if results else 0
    p95_latency = sorted(r["latency_ms"] for r in results)[int(len(results) * 0.95) - 1] if len(results) >= 20 else max((r["latency_ms"] for r in results), default=0)
    parse_ok = sum(1 for r in results if r["json_parse_ok"]) / len(results) if results else 0
    print(f"\nOverall accuracy: {overall_acc:.1%}  ({sum(1 for r in results if r['match'])}/{len(results)})")
    print(f"JSON parse ok:    {parse_ok:.1%}")
    print(f"Latency mean:     {avg_latency:.0f}ms")
    print(f"Latency p95:      {p95_latency}ms")

    # Confusion matrix (rows=true, cols=pred)
    print("\n=== Confusion matrix (rows=true, cols=pred) ===")
    cm = defaultdict(lambda: defaultdict(int))
    for r in results:
        cm[r["label"]][r["category"]] += 1
    header = "true\\pred       " + " ".join(f"{l[:6]:>7s}" for l in LABELS)
    print(header)
    for true in LABELS:
        cells = " ".join(f"{cm[true][pred]:>7d}" for pred in LABELS)
        total = sum(cm[true].values())
        print(f"{true:14s} {cells}  | {total}")

    # Routing-decision metrics (D-01/D-02). Production cares whether the email
    # is routed to drop / local / cloud, not strictly which category was named.
    # True route assumes confidence=1.0 (we know the ground truth); pred route
    # uses the model's actual confidence so the LOCAL_CONFIDENCE_FLOOR fallback
    # is honored.
    print("\n=== Routing accuracy (drop / local / cloud) ===")
    ROUTES = ["drop", "local", "cloud"]
    rcm = defaultdict(lambda: defaultdict(int))
    for r in results:
        true_route = route_for(r["label"], 1.0)
        pred_route = route_for(r["category"], r["confidence"])
        rcm[true_route][pred_route] += 1
    print(f"{'route':8s} {'support':>7s} {'preds':>5s} {'TP':>3s} "
          f"{'FP':>3s} {'FN':>3s} {'prec':>6s} {'recall':>6s} {'F1':>6s}")
    for route in ROUTES:
        tp = rcm[route][route]
        support = sum(rcm[route].values())
        preds = sum(rcm[r2][route] for r2 in ROUTES)
        fp = preds - tp
        fn = support - tp
        prec = tp / (tp + fp) if (tp + fp) else 0
        rec = tp / (tp + fn) if (tp + fn) else 0
        f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0
        print(f"{route:8s} {support:>7d} {preds:>5d} {tp:>3d} {fp:>3d} {fn:>3d} "
              f"{prec:>6.2f} {rec:>6.2f} {f1:>6.2f}")
    route_correct = sum(rcm[rt][rt] for rt in ROUTES)
    route_total = sum(sum(rcm[rt].values()) for rt in ROUTES)
    print(f"\nRoute accuracy: {route_correct/route_total:.1%}  ({route_correct}/{route_total})")
    print("\nRoute confusion (rows=true, cols=pred):")
    print(f"{'':8s} " + " ".join(f"{r2:>7s}" for r2 in ROUTES))
    for true_r in ROUTES:
        cells = " ".join(f"{rcm[true_r][pred_r]:>7d}" for pred_r in ROUTES)
        print(f"{true_r:8s} {cells}")


if __name__ == "__main__":
    main()
