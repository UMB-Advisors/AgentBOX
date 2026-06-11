#!/usr/bin/env python3
"""Ingest recent Google Drive docs into gbrain, per connected account.

For each token file in $HERMES_HOME/google_accounts/<email>.json (the
dashboard backend's own store — client_id/secret embedded, refresh_token
present), mint an access token via the standard OAuth refresh POST, list
the N most-recently-modified Google Docs (read-only API calls only),
export as text/plain (docs only — binaries are never downloaded; exports
larger than 1MB are skipped), distill with the local qwen3 (serial, 20s
timeout, degrades to a verbatim excerpt) and upsert into the
account-attributed entity source (heronlabsinc -> heron, umbadvisors ->
umb, consultingfutures -> personal).

Usage:
  python3 ingest_drive.py [--limit N] [--account EMAIL] [--dry-run]
                          [--no-llm] [--entity-map PATH]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import common
from attribution import attribute

GOOGLE_ACCOUNTS_DIR = Path(
    os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))
) / "google_accounts"
DOC_MIME = "application/vnd.google-apps.document"
EXPORT_MAX_BYTES = 1024 * 1024  # 1MB cap on exported text


def http_json(url: str, data: bytes | None = None, headers: dict | None = None,
              timeout: int = 30) -> dict:
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def mint_access_token(token_file: Path) -> tuple[str, str] | None:
    """Refresh-token flow against token_uri. Returns (email, access_token)."""
    rec = json.loads(token_file.read_text(encoding="utf-8"))
    email = rec.get("account") or token_file.stem
    if not rec.get("refresh_token"):
        common.log(f"{email}: no refresh_token, skipping")
        return None
    form = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "refresh_token": rec["refresh_token"],
        "client_id": rec["client_id"],
        "client_secret": rec["client_secret"],
    }).encode("ascii")
    try:
        data = http_json(
            rec.get("token_uri", "https://oauth2.googleapis.com/token"),
            data=form,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    except (urllib.error.URLError, ValueError) as exc:
        common.log(f"{email}: token refresh failed: {exc}")
        return None
    token = data.get("access_token")
    if not token:
        common.log(f"{email}: refresh response had no access_token")
        return None
    return email, token


def list_recent_docs(token: str, limit: int) -> list[dict]:
    q = urllib.parse.urlencode({
        "orderBy": "modifiedTime desc",
        "pageSize": str(limit),
        "q": f"mimeType = '{DOC_MIME}' and trashed = false",
        "fields": "files(id,name,mimeType,modifiedTime,webViewLink,owners(emailAddress))",
    })
    data = http_json(
        f"https://www.googleapis.com/drive/v3/files?{q}",
        headers={"Authorization": f"Bearer {token}"},
    )
    return data.get("files", [])


def export_doc_text(token: str, file_id: str) -> str | None:
    """Export a Google Doc as text/plain; None if oversized or failed."""
    url = (f"https://www.googleapis.com/drive/v3/files/"
           f"{urllib.parse.quote(file_id)}/export?mimeType=text/plain")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read(EXPORT_MAX_BYTES + 1)
    except urllib.error.URLError as exc:
        common.log(f"export failed for {file_id}: {exc}")
        return None
    if len(raw) > EXPORT_MAX_BYTES:
        common.log(f"export for {file_id} exceeds 1MB, skipping")
        return None
    return raw.decode("utf-8", errors="replace")


def distill(name: str, text: str, emap: dict, no_llm: bool) -> str:
    excerpt = text.strip()[:1200]
    if no_llm:
        return excerpt
    cfg = emap.get("summarizer", {})
    prompt = (
        "Summarize this document in 3-5 plain sentences: purpose, key points, "
        "and any decisions or action items. No preamble.\n\n"
        f"Title: {name}\n\n{text[:4000]}"
    )
    summary = common.ollama_generate(
        prompt,
        url=cfg.get("ollama_url", "http://127.0.0.1:11435"),
        model=cfg.get("model", "qwen3:4b-instruct"),
        timeout=int(cfg.get("timeout_seconds", 20)),
    )
    return summary or excerpt


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=25, help="docs per account (default 25)")
    ap.add_argument("--account", default=None, help="only this account email")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--entity-map", default=None)
    args = ap.parse_args()

    emap = common.load_entity_map(args.entity_map)
    kwargs = common.ladder_kwargs(emap)

    token_files = sorted(GOOGLE_ACCOUNTS_DIR.glob("*.json"))
    if args.account:
        token_files = [p for p in token_files if p.stem == args.account]
    if not token_files:
        common.log(f"no token files under {GOOGLE_ACCOUNTS_DIR}")
        return 1

    written = errors = 0
    for token_file in token_files:
        minted = mint_access_token(token_file)
        if not minted:
            errors += 1
            continue
        email, token = minted

        # Account-attributed: rung 1 for entity-owned accounts, rung 5
        # default otherwise (consultingfutures -> personal).
        entity = attribute(email, None, [], None, None, **kwargs)

        try:
            files = list_recent_docs(token, args.limit)
        except (urllib.error.URLError, ValueError) as exc:
            common.log(f"{email}: drive list failed: {exc}")
            errors += 1
            continue
        common.log(f"{email}: {len(files)} recent docs -> source {entity.entity}")

        for f in files:
            fid = f["id"]
            name = f.get("name") or fid
            slug = (f"drive/{common.slugify(name)}-"
                    f"{hashlib.sha1(fid.encode()).hexdigest()[:8]}")
            if args.dry_run:
                print(f"DRY {entity.entity:10s} {slug} ({name[:60]})")
                continue
            text = export_doc_text(token, fid)
            if text is None:
                continue
            frontmatter = {
                "title": name[:140],
                "type": "drive-doc",
                "visibility": "world",
                "account": email,
                "entity": entity.entity,
                "drive_id": fid,
                "modified": f.get("modifiedTime"),
                "link": f.get("webViewLink"),
                "tags": ["drive", f"entity:{entity.entity}",
                         "account:" + common.slugify(email.split("@")[0])],
            }
            body = "\n".join([
                f"# {name}",
                "",
                f"Google Doc on account {email}, modified {f.get('modifiedTime', '?')}.",
                "",
                "## Summary",
                "",
                distill(name, text, emap, args.no_llm),
            ])
            try:
                common.gbrain_capture(entity.entity, slug,
                                      common.render_page(frontmatter, body),
                                      page_type="drive-doc")
                written += 1
            except RuntimeError as exc:
                errors += 1
                common.log(f"ERROR {slug}: {exc}")

    common.log(f"done: written={written} errors={errors}")
    return 1 if errors and not written else 0


if __name__ == "__main__":
    sys.exit(main())
