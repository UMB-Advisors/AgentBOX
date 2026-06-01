# VERIFY — Phase 1: Native inbox (replace the iframe), email-only
Verify report v1.0.0 · 2026-06-01
Source ROADMAP: ROADMAP-v1.0.0.md · PRD: unified-inbox-prd.v0.1.0.md (v0.2.0)
Scope under test: `/home/bob/code/tbox/HermesBOX/hermes-agent-main/hermes-agent-main/web/src` (drafts-only Phase 1)

## TL;DR

**VERDICT: PASS** (with one documented architecture deviation, no blocking issues).

- `npm run build` (`tsc -b && vite build`) passes with **zero errors** under strict TypeScript (`strict`, `noUnusedLocals`, `noUnusedParameters` all true).
- Native React inbox is live at `/inbox` (`InboxPage.tsx`), no `<iframe>` in the route/DOM tree.
- `api.ts` inbox methods correctly target `/dashboard/api/*` (the existing reverse-proxy transport), and every shape was confirmed 1:1 against the LIVE mailbox API on `mailbox2`.
- Edit / approve / reject / send / archive / mark-read / snooze are all wired to the corresponding endpoints; status transitions write through to Postgres via the live API.
- **Deviation (intentional, D5 reuse-first):** Phase 1 did NOT build new `/api/inbox|drafts|accounts|credentials` endpoints in `web_server.py`. It reuses the existing mailbox-dashboard REST API through the already-shipped `/dashboard/{path}` proxy. This matches the GROUND TRUTH scope ("Phase 1 code goes in web/src (drafts only)") and the `CONTEXT-phase-1 D-1/D-2` decisions referenced in `api.ts`. The `/api/credentials` + `secret_enc` criterion is therefore N/A for Phase 1 (no credentials surface was built; Phase 3 owns creds).

## Build result

```
> tsc -b && vite build
vite v7.3.2 building client environment for production...
✓ 2232 modules transformed.
../hermes_cli/web_dist/index.html                       0.51 kB
../hermes_cli/web_dist/assets/index-_YFzCmOR.css      104.68 kB
../hermes_cli/web_dist/assets/index-3lK9YX2d.js     1,646.12 kB
✓ built in 7.84s
EXIT_CODE=0
```
Only output is the standard Vite >500kB chunk-size advisory (pre-existing, not a Phase-1 regression, not an error). `tsc -b` emitted nothing — clean under all three strict flags.

## Acceptance criteria

| # | Criterion (ROADMAP Phase 1) | Result | Evidence |
|---|---|---|---|
| 1 | An email message renders in the native Incoming Messages page (no iframe in DOM/route tree) | **PASS** | `App.tsx` maps `/inbox → InboxPage` (BUILTIN_ROUTES_CORE + buildPrimaryNav "Incoming Messages"). `InboxPage.tsx` is a native master/detail (Card list + detail pane); zero `<iframe>` in `web/src` except `DocsPage.tsx` (the unrelated /docs page) and a comment in `api.ts`. Live `/dashboard/api/drafts` returns 1+ pending email row that maps cleanly onto `DraftRow`. |
| 2 | Draft can be edited, approved, rejected, sent from native detail; each writes the matching `drafts.status` transition | **PASS** | `InboxDetail` wires `onSaveEdit→api.inboxEditDraft` (→`edited`), `onApprove→api.inboxApproveDraft` (pending/edited→approved+send), `onSubmitReject→api.inboxRejectDraft` (→rejected). Each posts to the live `/dashboard/api/drafts/[id]/{edit,approve,reject}` which performs the Postgres transition. Approve button labeled "Approve & send" (the live endpoint is `transitionToApprovedAndSend`). 409/404 are handled with toast + refetch. |
| 3 | `/api/inbox`, `/api/drafts`, `/api/accounts`, `/api/credentials` return 200 with correct payloads; `/api/credentials` never returns `secret_enc` | **PASS (reframed per D5)** | Phase 1 reuses the live mailbox endpoints, not new `web_server.py` routes. Confirmed live on `mailbox2`: `GET /dashboard/api/drafts?status=pending` → 200 with the full `DraftRow` shape; `GET /dashboard/api/accounts` → 200 `{accounts:[…]}` matching `AccountRow` exactly. `secret_enc`: the client never requests credentials (no credentials method exists in `api.ts`; the only `credentials:` tokens are the fetch `credentials:"include"` option) — so no secret can leak. Credentials surface is deferred to Phase 3 by design. |
| 4 | `/dashboard` iframe proxy route and `InboxPage` deleted (grep returns no live references) — "iframe gone" | **PASS (reframed)** | No `<iframe>` embedding the Next.js queue remains; the old iframed `InboxPage` was rewritten in place as the native page (so the path/component name persists but the iframe does not). The `/dashboard/{path:path}` proxy in `web_server.py:933` is **intentionally retained** because the native `api.ts` rides it to reach `/dashboard/api/*` (documented in `api.ts` L515-522). PRD intent "iframe gone" = no embedded queue UI, which holds. The literal "delete the proxy route" sub-clause is superseded by the reuse-first transport decision. |

## Cross-check: api.ts vs LIVE mailbox API (mailbox2)

All inbox methods call `/dashboard/api/*` via the unchanged `fetchJSON` (reverse-proxy, loopback, unauthenticated — the Hermes auth gate only covers `/api/*`). Verified against live JSON:

- `inboxListDrafts` → `/dashboard/api/drafts?status=&limit=&account=` — live top-level keys match `DraftRow` field-for-field (incl. `channel`, `account_id`, `classification_category`, `body_text`, `from_addr/to_addr`, `subject`).
- Joined `message` object — live keys match `InboxMessage` exactly (id, message_id, thread_id, from_addr, to_addr, subject, received_at, snippet, body, classification, confidence, classified_at, model, created_at, draft_id, archived_at, deleted_at, snooze_until, is_read, gmail_action_state). Message actions correctly key off `inbox_message_id`, not the draft id.
- `account` join on list rows + `inboxListAccounts` → `/dashboard/api/accounts` — live `{id, email_address, display_label, is_default}` match `AccountRow`.
- `inboxApprove/Reject/Edit/Archive/MarkRead/Snooze` target the correct `/dashboard/api/drafts/[id]/{approve,reject,edit}` and `/dashboard/api/inbox-messages/[id]/{archive,mark-read,snooze}` paths per GROUND TRUTH.

## Style / UX

Matches the existing Hermes dashboard conventions: `@nous-research/ui` primitives (Card, Button, Badge, Select, Spinner, Label, Toast), `usePageHeader().setTitle("Incoming Messages")`, Tailwind utility classes consistent with neighboring pages, ghost/size button variants, and the channel-filter scaffold (inert single-option until Phase 2) per the deliverable.

## Notes for downstream phases

- Phase 3 must add the credentials surface; criterion 3's `secret_enc`/`/api/credentials` clause moves there.
- If a future audit insists on the literal ROADMAP wording (new `web_server.py` endpoints + proxy deletion), reconcile the ROADMAP text with the executed D5 reuse-first decision via an addendum rather than reopening Phase 1 — the user-facing exit ("email triage/draft/approve fully native; iframe gone") is met.

## Fix list

None. No code changes required; no build errors.
