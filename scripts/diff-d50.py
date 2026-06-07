#!/usr/bin/env python3
"""Diff D-50 vs pre-D-50 scoring runs to surface which rows flipped."""
import csv
import sys

PRE = sys.argv[1] if len(sys.argv) > 1 else "scripts/heron-labs-corpus.scored-2026-04-30.pre-D50.csv"
POST = sys.argv[2] if len(sys.argv) > 2 else "scripts/heron-labs-corpus.scored-2026-04-30.csv"

LOCAL_CONFIDENCE_FLOOR = 0.75
LOCAL_CATS = {"reorder", "scheduling", "follow_up", "internal"}


def route(cat, conf):
    if cat == "spam_marketing":
        return "drop"
    if conf < LOCAL_CONFIDENCE_FLOOR:
        return "cloud"
    if cat in LOCAL_CATS:
        return "local"
    return "cloud"


def load(path):
    rows = {}
    with open(path) as f:
        for r in csv.DictReader(f):
            rows[r["id"]] = r
    return rows


pre = load(PRE)
post = load(POST)
ids = set(pre) & set(post)

flips = []
for i in ids:
    a = pre[i]
    b = post[i]
    pa, pb = a["pred_label"], b["pred_label"]
    ca, cb = float(a["confidence"]), float(b["confidence"])
    ra, rb = route(pa, ca), route(pb, cb)
    if pa != pb or ra != rb:
        flips.append({
            "id": i,
            "from": a["from_addr"],
            "true": a["true_label"],
            "pre": pa,
            "pre_r": ra,
            "post": pb,
            "post_r": rb,
            "preclass": b.get("preclass_applied", ""),
        })

print(f"Total flips: {len(flips)}/{len(ids)}")
print()
print(f'{"id":<22} {"from":<32} {"true":<14} {"pre→post (cat)":<32} {"pre→post (route)":<20} preclass')
print("-" * 130)
for f in flips:
    cat_change = f"{f['pre']:<14}->{f['post']:<14}"
    route_change = f"{f['pre_r']:<7}->{f['post_r']:<7}"
    print(f"{f['id']:<22} {f['from'][:30]:<32} {f['true']:<14} {cat_change:<32} {route_change:<20} {f['preclass']}")

# Summarize route flips
print()
print("Route flip summary (true_route -> pre_route -> post_route):")
buckets = {}
for f in flips:
    if f['pre_r'] != f['post_r']:
        true_r = route(f['true'], 1.0)
        key = f"{true_r} | {f['pre_r']} -> {f['post_r']}"
        buckets[key] = buckets.get(key, 0) + 1
for k, v in sorted(buckets.items()):
    print(f"  {k}: {v}")
