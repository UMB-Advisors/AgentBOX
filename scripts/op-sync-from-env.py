#!/usr/bin/env python3
"""
Render a 1Password "Server" item JSON template from a `.env` stream on stdin.

Designed to land MailBox-appliance secrets into 1Password without ever
exposing them to argv, shell history, or the captured stdout of an
orchestration tool. The full pipeline is one shell line:

    ssh <appliance> 'cat /home/<user>/mailbox/.env' | \\
      scripts/op-sync-from-env.py <title> <url> <ssh_user> <tailnet_host> <lan_ip> | \\
      op item create --vault MailBOX -

Secret values flow ssh-stdin → this process → op-stdin entirely through
pipe memory; they are never written to disk locally and never appear as
process arguments.

Field-type detection is by name: any key containing PASSWORD, TOKEN,
KEY, HASH, SECRET, or PASS is rendered as CONCEALED in 1Password (icon
🔒, masked unless --reveal). Unknown-prefix keys land in a "Misc" section.

Per-key section routing lives in SECTION_BY_PREFIX. Order matters —
first prefix match wins, so put more-specific prefixes first
(e.g. MAILBOX_BASIC_AUTH before MAILBOX_).
"""
import json
import sys


CONCEALED_HINTS = ("PASSWORD", "TOKEN", "KEY", "HASH", "SECRET", "PASS")

# First match wins. Keep more specific prefixes above broader ones.
SECTION_BY_PREFIX = [
    ("MAILBOX_BASIC_AUTH", ("caddy", "Caddy")),
    ("CADDY_", ("caddy", "Caddy")),
    ("CLOUDFLARE_", ("cloudflare", "Cloudflare")),
    ("POSTGRES_", ("postgres", "Postgres")),
    ("OLLAMA_CLOUD_", ("llm", "LLM")),
    ("ANTHROPIC_", ("llm", "LLM")),
    ("N8N_", ("n8n", "n8n")),
    ("OLLAMA_IMAGE", ("config", "Config")),
    ("CADDY_EMAIL", ("config", "Config")),
    ("DOMAIN", ("config", "Config")),
    ("MAILBOX_OPERATOR_EMAIL", ("operator", "Operator")),
    ("TTYD_", ("legacy", "Legacy")),
]


def parse_env(stream):
    """Parse a `.env` stream into a dict. Strips inline comments unless quoted."""
    out = {}
    for line in stream:
        line = line.rstrip("\n")
        if not line.lstrip() or line.lstrip().startswith("#"):
            continue
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip()
        # Quoted value: keep verbatim contents
        if len(v) >= 2 and v[0] in ("'", '"') and v.endswith(v[0]):
            v = v[1:-1]
        else:
            # Strip trailing whitespace+# inline comment
            for i, ch in enumerate(v):
                if ch == "#" and (i == 0 or v[i - 1] in " \t"):
                    v = v[:i].rstrip()
                    break
        out[k] = v
    return out


def section_for(key):
    for prefix, sec in SECTION_BY_PREFIX:
        if key.startswith(prefix) or key == prefix:
            return sec
    return ("misc", "Misc")


def field_type(key):
    return "CONCEALED" if any(h in key for h in CONCEALED_HINTS) else "STRING"


def main():
    if len(sys.argv) != 6:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    title, url, ssh_user, tailnet_host, lan_ip = sys.argv[1:]

    env = parse_env(sys.stdin)

    sections_seen = {}
    fields = [
        {
            "id": "notesPlain", "type": "STRING", "purpose": "NOTES",
            "label": "notesPlain",
            "value": f"MailBox One appliance — {title}\n"
                     f"Generated from live .env on {tailnet_host}.",
        },
        {"id": "url", "type": "STRING", "label": "URL", "value": url},
        {"id": "username", "type": "STRING", "label": "username", "value": ssh_user},
        {"id": "password", "type": "CONCEALED", "label": "password", "value": ""},
    ]

    # Operator section: pre-populated network identity (filled from CLI args
    # rather than .env so they always land even if a customer's env omits them).
    sections_seen["operator"] = "Operator"
    for fid, ftype, val in (
        ("ssh_user", "STRING", ssh_user),
        ("tailnet_host", "STRING", tailnet_host),
        ("lan_ip", "STRING", lan_ip),
    ):
        fields.append({
            "id": fid,
            "section": {"id": "operator", "label": "Operator"},
            "type": ftype, "label": fid, "value": val,
        })

    for key in sorted(env.keys()):
        sec_id, sec_label = section_for(key)
        sections_seen[sec_id] = sec_label
        fields.append({
            "id": key.lower(),
            "section": {"id": sec_id, "label": sec_label},
            "type": field_type(key),
            "label": key,
            "value": env[key],
        })

    item = {
        "title": title,
        "category": "SERVER",
        "tags": ["mailbox", title],
        "sections": [{"id": sid, "label": slabel}
                     for sid, slabel in sections_seen.items()],
        "fields": fields,
    }
    json.dump(item, sys.stdout)


if __name__ == "__main__":
    main()
