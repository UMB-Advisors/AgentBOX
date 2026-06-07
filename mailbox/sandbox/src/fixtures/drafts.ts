// Synthetic fixtures for the sandbox UI. The original file (kept local-only on
// the dev workstation) contains real production message bodies pulled from M1.
// This file is a same-shape placeholder so the sandbox runs end-to-end without
// shipping customer data into the repo. Names, companies, and addresses below
// are fabricated.
//
// STAQPRO-404: Coverage matrix below — every classification category and every
// urgency signal must hit at least one row. `is_vip` is the only signal that
// can't be derived from existing fields; everything else (escalate / aged /
// low_conf) is derived in `lib/urgency.ts` from existing columns.

export type DraftStatus = "pending" | "approved" | "sent" | "rejected";

export interface PriorMessage {
  direction: "inbound" | "outbound";
  from_addr: string;
  body: string;
  at: string;
}

export interface DraftRow {
  id: number;
  status: DraftStatus;
  created_at: string;
  draft_source: string;
  model: string;
  classification_confidence: number | null;
  classification_category: string;
  from_addr: string;
  subject: string;
  received_at: string | null;
  inbound_body_preview: string;
  draft_subject: string | null;
  draft_body: string;
  sent_at?: string | null;
  approved_at?: string | null;
  prior_messages?: PriorMessage[];
  /**
   * STAQPRO-404: explicit fixture flag for the VIP urgency signal. The only
   * signal that can't be derived from existing fields. In production this will
   * be sourced from a per-counterparty VIP list (`mailbox.persona.vip_senders`
   * or similar — out of scope for the UI exploration phase).
   */
  is_vip?: boolean;
}

// "Now" for the sandbox is 2026-05-18 per the project currentDate. Fixture
// received_at values are anchored against this so the `aged` signal is
// deterministic at fixture-time (NOT at viewing-time).
//
// To recompute an "X hours ago" timestamp from 2026-05-18T12:00:00Z:
//   5h ago  → 2026-05-18T07:00:00+00:00
//   26h ago → 2026-05-17T10:00:00+00:00
//   30h ago → 2026-05-17T06:00:00+00:00
export const drafts: DraftRow[] = [
  {
    id: 1,
    status: "pending",
    created_at: "2026-05-14T15:02:11+00:00",
    draft_source: "cloud",
    model: "gpt-oss:120b",
    classification_confidence: 0.94,
    classification_category: "escalate",
    from_addr: "alex@northstarretail.example",
    subject: "Shipment arrived damaged — need to talk before EOD",
    received_at: "2026-05-14T14:48:02+00:00",
    inbound_body_preview:
      "Hi Jordan,\n\nThree of the twelve cases from last week's order showed up with crushed corners and visible product damage. Our store manager is asking whether we should keep ordering from you — I'd like to get on a call today to figure out a path forward before this turns into something bigger.\n\nCan you pull the carrier paperwork and call me back this afternoon?\n\n— Alex",
    draft_subject: null,
    draft_body:
      "Alex,\n\nAcknowledged — I'll have the carrier paperwork pulled within the hour and I'll call you back by 3pm your time.\n\nBefore we talk I'll have answers on:\n* the damage pattern (carrier vs packaging at our end),\n* immediate replacement timing for the three damaged cases,\n* what we can do on the next shipment to prevent a repeat.\n\nIf you'd prefer to escalate to my partner Sam directly, just say the word and I'll loop them in.\n\n— Jordan",
    prior_messages: [
      {
        direction: "inbound",
        from_addr: "alex@northstarretail.example",
        at: "2026-05-07T16:21:00+00:00",
        body: "Jordan,\n\nGot the latest PO ack — looks good, thanks. Will flag if anything looks off on receipt.\n\n— Alex",
      },
    ],
  },
  {
    id: 2,
    status: "pending",
    created_at: "2026-05-14T13:41:09+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.91,
    classification_category: "reorder",
    from_addr: "purchasing@meadowgrocers.example",
    subject: "Reorder — same as last month, plus 2 cases of the citrus SKU",
    received_at: "2026-05-14T13:28:44+00:00",
    inbound_body_preview:
      "Hi team,\n\nReady to reorder. Same quantities as the April PO, plus an additional 2 cases of the citrus variety — it's been moving well at the front of the store.\n\nPlease send the PO ack and a target ship date when you have a minute.\n\nThanks,\nDana — Meadow Grocers Purchasing",
    draft_subject: null,
    draft_body:
      "Dana,\n\nThanks — got the reorder. I'll mirror the April PO and add 2 cases of the citrus SKU.\n\nTarget ship date is Friday this week pending warehouse confirmation; I'll send the PO ack with line items and the freight quote later today.\n\n— Jordan",
  },
  {
    id: 3,
    status: "pending",
    created_at: "2026-05-14T11:55:22+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.88,
    classification_category: "scheduling",
    from_addr: "morgan@harborcoffee.example",
    subject: "Can we move Thursday's tasting to next week?",
    received_at: "2026-05-14T11:42:10+00:00",
    inbound_body_preview:
      "Hey Jordan,\n\nOur GM is going to be out Thursday — any chance we push the in-store tasting to the following Tuesday or Wednesday? Same time slot ideally.\n\n— Morgan",
    draft_subject: null,
    draft_body:
      "Morgan,\n\nNo problem — Tuesday the 26th at the same time works on my end. I'll update the calendar invite and re-confirm the sample list.\n\nIf Wednesday is easier for the GM, that's open for me too — just say the word.\n\n— Jordan",
  },
  {
    id: 4,
    status: "approved",
    created_at: "2026-05-14T10:12:00+00:00",
    approved_at: "2026-05-14T10:18:35+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.86,
    classification_category: "follow_up",
    from_addr: "ravi@brightline.example",
    subject: "Following up on the sample request from last month",
    received_at: "2026-05-14T09:58:01+00:00",
    inbound_body_preview:
      "Jordan,\n\nCircling back on the sample request from April — did the kit ever go out? We're moving into our summer planning cycle and I want to make sure your line is on the consideration list.\n\n— Ravi",
    draft_subject: null,
    draft_body:
      "Ravi,\n\nThanks for the nudge — the kit shipped on the 3rd and the tracking shows delivered the 6th. Let me know if it didn't reach you and I'll get a replacement out same-day.\n\nHappy to set up a 20-min call once you've had a chance to taste through it.\n\n— Jordan",
  },
  {
    // Re-anchored to "received 2h before the 2026-05-18T12:00Z digest clock"
    // (was 2026-05-14 — pre-anchor) so this row stays NON-aged and shows up
    // in the digest's "Pending by category" section under `inquiry`, giving
    // the section at least 2 category groups alongside spam_marketing (id 101).
    id: 5,
    status: "pending",
    created_at: "2026-05-18T10:00:14+00:00",
    draft_source: "cloud",
    model: "gpt-oss:120b",
    classification_confidence: 0.82,
    classification_category: "inquiry",
    from_addr: "priya@studiothree.example",
    subject: "Wholesale terms + lead time question",
    received_at: "2026-05-18T09:55:48+00:00",
    inbound_body_preview:
      "Hi — found you through a colleague. We run a small chain (4 locations) and are evaluating new vendors for Q3. Could you share your wholesale price list, MOQ, and typical lead time from PO to dock?\n\nThanks,\nPriya",
    draft_subject: null,
    draft_body:
      "Priya,\n\nGreat to hear from you. Attaching our current wholesale sheet with MOQ and lead time at the top (10 cases per SKU, 7–10 business days from PO).\n\nIf it's useful I can drop a sample kit in the mail this week — just send the address you'd like it sent to.\n\n— Jordan",
  },
  {
    // Anchored within the last 24h relative to the 2026-05-18T12:00Z digest
    // clock so the digest preview's "Sent in the last 24h" section is
    // non-empty. STAQPRO-404 Task 4 verify gate requires this.
    id: 6,
    status: "sent",
    created_at: "2026-05-17T17:02:55+00:00",
    approved_at: "2026-05-17T17:09:12+00:00",
    sent_at: "2026-05-17T17:09:14+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.93,
    classification_category: "internal",
    from_addr: "sam@example-co.example",
    subject: "warehouse coverage next Friday",
    received_at: "2026-05-17T16:50:21+00:00",
    inbound_body_preview:
      "Jordan — I'll be out next Friday for the dentist thing. Can you cover the morning inbound window so receiving doesn't stack up?\n\n— Sam",
    draft_subject: null,
    draft_body:
      "Sam,\n\nCovered — I'll be onsite 8–noon. Anything you want me to flag while I'm there?\n\n— Jordan",
  },
  {
    id: 7,
    status: "rejected",
    created_at: "2026-05-13T15:11:08+00:00",
    draft_source: "cloud",
    model: "gpt-oss:120b",
    classification_confidence: 0.61,
    classification_category: "unknown",
    from_addr: "promotions@vendorlist.example",
    subject: "Last chance — annual partner survey closes today",
    received_at: "2026-05-13T15:02:00+00:00",
    inbound_body_preview:
      "Hi Partner,\n\nOur annual partner survey closes today. Click here to share your feedback and be entered to win a $250 gift card!\n\nThanks,\nThe Vendorlist Team",
    draft_subject: null,
    draft_body:
      "Thanks — we'll take a look when we have a moment.\n\n— Jordan",
  },
  {
    id: 8,
    status: "pending",
    created_at: "2026-05-14T16:44:30+00:00",
    draft_source: "cloud",
    model: "gpt-oss:120b",
    classification_confidence: 0.72,
    classification_category: "escalate",
    from_addr: "legal@bigboxgrocer.example",
    subject: "Updated vendor compliance packet — signature required",
    received_at: "2026-05-14T16:30:11+00:00",
    inbound_body_preview:
      "Vendor,\n\nPlease find attached our updated compliance packet covering insurance minimums, traceability requirements, and recall procedures. Signature and return required within 14 days to remain an active vendor.\n\n— BigBox Grocer Legal",
    draft_subject: null,
    draft_body:
      "Hi —\n\nReceived; I'll route this to our partner Sam and our insurance broker for review and circle back with the signed packet inside the 14-day window. If anything in the new minimums creates a gap we'll flag it before signing.\n\n— Jordan",
  },
  // -------------------------------------------------------------------------
  // STAQPRO-404 coverage rows (id ≥ 100 to stay clear of the original block).
  // -------------------------------------------------------------------------
  {
    // Covers: `spam_marketing` category. Pending so the category-filter chip
    // can demo "filter it out." Confidence 0.96 so it does NOT trip low_conf.
    id: 101,
    status: "pending",
    created_at: "2026-05-18T11:30:00+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.96,
    classification_category: "spam_marketing",
    from_addr: "deals@superdealsblast.example",
    subject: "🔥 50% off enterprise CRM — this week only",
    received_at: "2026-05-18T11:25:00+00:00",
    inbound_body_preview:
      "Hi there,\n\nThis week only: 50% off our enterprise CRM platform with annual contract. Click below to schedule a demo. Limited time offer.\n\nBest,\nDealsBlast Sales Team",
    draft_subject: null,
    draft_body: "(no draft — spam_marketing route drops)",
  },
  {
    // Covers: `aged` signal (status=pending, received_at = 5h ago).
    // Confidence 0.93 so low_conf does NOT also fire — keep this row clean
    // to demonstrate the single-pill (non-aggregate) UrgencyBadge.
    id: 102,
    status: "pending",
    created_at: "2026-05-18T07:05:00+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.93,
    classification_category: "reorder",
    from_addr: "kim@coastalmarkets.example",
    subject: "May restock — same lineup as April",
    received_at: "2026-05-18T07:00:00+00:00",
    inbound_body_preview:
      "Hey Jordan,\n\nReady for the May restock — same lineup as April, plus we're going to try adding the cherry SKU at 4 stores. Can you confirm timing?\n\n— Kim",
    draft_subject: null,
    draft_body:
      "Kim,\n\nGot it — April lineup mirrored plus 4 cases of the cherry SKU split across the four stores. Ship target is Wednesday; I'll send the PO ack with the freight quote within the hour.\n\n— Jordan",
  },
  {
    // Covers: `vip` signal (is_vip=true) on a pending row that is NOT aged
    // and NOT low_conf. Demonstrates VIP showing as a single-pill UrgencyBadge.
    // Received 1.5h ago (NOT aged) and confidence 0.89 (NOT low_conf).
    id: 103,
    status: "pending",
    created_at: "2026-05-18T10:35:00+00:00",
    draft_source: "local",
    model: "qwen3:4b-ctx4k",
    classification_confidence: 0.89,
    classification_category: "scheduling",
    from_addr: "ceo@anchorinvest.example",
    subject: "Quick chat next week?",
    received_at: "2026-05-18T10:30:00+00:00",
    is_vip: true,
    inbound_body_preview:
      "Jordan — got 20 minutes next week to walk through Q3 numbers? I'm flexible Tue-Thu mornings PT.\n\n— Casey",
    draft_subject: null,
    draft_body:
      "Casey,\n\nAbsolutely — Tuesday 9am PT or Thursday 10am PT both work on my end. Let me know which fits and I'll send the invite.\n\n— Jordan",
  },
  {
    // Covers: `low_conf` signal on a pending LOCAL-route row (id 8 already
    // covers low_conf on a CLOUD-route row). Confidence 0.68 trips low_conf;
    // category is `inquiry` (LOCAL) and route resolves to 'cloud' anyway
    // because confidence < 0.75. So this also exercises the
    // "low confidence forces cloud route" rule in routeFor.
    id: 104,
    status: "pending",
    created_at: "2026-05-18T11:50:00+00:00",
    draft_source: "cloud",
    model: "gpt-oss:120b",
    classification_confidence: 0.68,
    classification_category: "inquiry",
    from_addr: "ops@unfamiliarbrand.example",
    subject: "Question about your packaging",
    received_at: "2026-05-18T11:45:00+00:00",
    inbound_body_preview:
      "Hello,\n\nWe came across your product and have a question about whether your secondary packaging is compostable. Trying to source for our Q3 launch.\n\n— Ops, Unfamiliar Brand",
    draft_subject: null,
    draft_body:
      "Hi —\n\nThe carton is curbside-recyclable but not certified compostable; the inner film is compostable in industrial facilities only. Happy to send the spec sheet — what region are you launching in?\n\n— Jordan",
  },
  {
    // Covers: aggregate (>=2 signals) demo row. is_vip=true + aged (30h ago)
    // + low_conf (0.71). 3 signals fire → UrgencyBadge renders the aggregate
    // AlertOctagon icon with count. This is THE demo row for the aggregate
    // badge deliverable.
    id: 105,
    status: "pending",
    created_at: "2026-05-17T06:05:00+00:00",
    draft_source: "cloud",
    model: "gpt-oss:120b",
    classification_confidence: 0.71,
    classification_category: "follow_up",
    from_addr: "founder@anchorinvest.example",
    subject: "Re: Q3 numbers — also, board meeting prep",
    received_at: "2026-05-17T06:00:00+00:00",
    is_vip: true,
    inbound_body_preview:
      "Jordan,\n\nFollowing up on the Q3 numbers thread + I need a quick rundown of the operating margin trajectory for the board deck on Friday. Can you pull together one slide's worth of context?\n\n— Marin",
    draft_subject: null,
    draft_body:
      "Marin,\n\nWill have a one-slide summary by Wednesday evening covering Q3 trajectory, the two contracts that moved out of Q3 into Q4, and the operating-margin walk vs plan.\n\nHappy to hop on a 10-min call Friday morning before the board meeting if useful.\n\n— Jordan",
  },
];
