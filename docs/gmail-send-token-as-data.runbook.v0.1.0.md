# Gmail send → token-as-data migration runbook

**Version:** 0.1.0
**Date:** 2026-06-25
**Implements:** the deferred **P0.5** from `n8n-credential-unification-prd.addendum-02.md`
**Issue:** Gmail send failing with `NodeApiError: Authorization failed` — the
native `gmailOAuth2` credential (id `vEz5mz0uaAtlK8yz`) expired (Google revokes
refresh tokens for "testing"-status apps ~weekly). Volume/rate-limit was never
the cause.

## What this changes

`MailBOX-Send.json`'s **`Gmail Reply`** node (native `n8n-nodes-base.gmail`,
stored OAuth2 credential) is replaced by the **token-as-data** pattern already
used by the Gmail *read* path and `MailBOX-Graph-Send`:

```
Lock Acquired? → Get Gmail Token → Build Reply MIME → Gmail Send → Mark Sent
```

- **Get Gmail Token** — `GET mailbox-dashboard:3001/dashboard/api/internal/google/access-token`
  (`X-Hermes-Internal-Token` header). Mints a fresh access token by refreshing
  the **healthy master** `google_token.json` (has `gmail.send` + a refresh
  token). No more separate, expiring n8n credential.
- **Build Reply MIME** — Code node: builds a base64url RFC822 message
  (To=original sender, From=receiving mailbox, `Re:` subject, best-effort
  `In-Reply-To`/`References` from the original Message-ID) and a `{raw, threadId}`
  body. Threading is carried primarily by `threadId`.
- **Gmail Send** — `POST gmail.googleapis.com/gmail/v1/users/me/messages/send`
  with `Authorization: Bearer <minted token>`.

The DB lock / draft-load / already-sent / respond nodes are unchanged;
`Mark Sent.sent_gmail_message_id` now reads `$('Gmail Send').item?.json?.id`.

## ⚠️ This is the production send path — test before trusting it

It could not be validated locally (no live n8n/Gmail rig). **Do a safe test
send first**, not a real contact:

1. **Import** on the box:
   ```bash
   ssh UMB@100.127.2.54
   cd ~/<agentbox checkout>            # wherever mailbox/ lives on the box
   bash mailbox/scripts/n8n-import-workflows.sh   # imports MailBOX-Send.json
   ```
   (or import `MailBOX-Send.json` via the n8n editor — see access below.)
2. **Safe test:** approve a draft that replies to an email **from your own
   address** (or temporarily edit the draft's recipient to yourself). Confirm
   the received reply has: correct body, `Re:` subject, lands in the right
   thread, correct From.
3. Only after that looks right, use it on real drafts.

## Rollback

The previous workflow is one `git checkout` away:
```bash
git show pre-redesign-baseline:mailbox/n8n/workflows/MailBOX-Send.json  # old version (or main@ab7cbac~)
```
Re-import the old `MailBOX-Send.json` and (if needed) re-link the `gmailOAuth2`
credential. The change is workflow-only; no schema/migration.

## Immediate stopgap (until this is imported + tested)

Re-authorize the existing n8n Gmail credential:
- n8n editor is bound to `127.0.0.1:5678` on the box (not on the tunnel). Reach
  it: `ssh -L 5678:127.0.0.1:5678 UMB@100.127.2.54`, then open
  `http://localhost:5678`.
- Credentials → **Gmail account** (`gmailOAuth2`, id `vEz5mz0uaAtlK8yz`) →
  reconnect → Google consent. Sends resume immediately (but will expire again —
  which is why this migration exists).
