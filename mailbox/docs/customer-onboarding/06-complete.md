# Step 6: You're live

> Wizard route: `/onboarding/complete` — see `dashboard/app/onboarding/complete/page.tsx`

## What this step does

<!-- VOICEOVER: The appliance is now running. The first draft will hit the queue on the next 5-minute poll. -->

- **What you see:** a success card confirming setup is done, a short countdown to the next inbox check, and an **Open queue** button that takes you to your approval queue.
- **What the appliance is doing:** it starts checking your inbox every five minutes, sends you a short "you're live" confirmation email, and begins quietly learning your writing style from your recent sent mail so future drafts sound more like you.
- **What you need to do:** click **Open queue** and keep an eye on it. The first draft appears within about five minutes of a new email arriving.

## Where you'll work day to day

Your home base from now on is the **approval queue** at:

> `https://<your-appliance-address>/dashboard/queue`

Bookmark it. Whenever a new email comes in that's worth a reply, the appliance writes a draft and puts it here. For each one you can:

- **Approve** — send the draft as-is.
- **Edit** — tweak the wording, then send.
- **Reject** — discard the draft (nothing is sent).

Nothing is ever sent without you approving it.

## Screenshots

<!-- SCREENSHOT: M1 onboarding /onboarding/complete — success card with the next-check countdown and "Open queue" button -->
<!-- SCREENSHOT: M1 operator inbox — the "you're live" confirmation email as it arrives -->
<!-- SCREENSHOT: M1 dashboard /dashboard/queue — empty state, waiting for the first draft -->

## Voiceover beats

<!-- VOICEOVER: hook — "That's it — your appliance is live." (10-15 words) -->
<!-- VOICEOVER: action prompt — "Tap Open queue. The first draft lands in under five minutes." -->
<!-- VOICEOVER: closer — "If a question comes in, you'll see the draft here ready to approve, edit, or reject." -->

## Common questions

**What if no draft shows up?** First, make sure there's actually new, unread mail in the connected inbox worth replying to — routine newsletters and obvious spam are skipped on purpose. The appliance checks every five minutes, so give it up to that long. If you've waited ten minutes with genuine new mail and still see nothing, see the troubleshooting page (`07-troubleshooting.md`).

**Can I undo setup?** Yes — contact support and they can reset the appliance back to the start of onboarding.

**How do I make drafts sound more like me?** They already use the name, brand, and signoff you set in Step 3, and they improve as the appliance reads more of your sent mail. You can fine-tune your voice any time from the settings page.

**Will it ever send an email without me?** No. Every reply waits in the queue for you to approve, edit, or reject.

## What to do if it fails

**No draft appears within ten minutes, even though you have genuine new mail.** Open the troubleshooting page (`07-troubleshooting.md`) and check the **Classify lag** indicator on the status page first — that's the fastest way to tell whether the box is processing mail. (Support reference: check the workflow execution log and confirm all four workflows are active.)

**The "you're live" confirmation email never arrived.** Check your spam folder. If it's not there, the appliance may not be able to send yet — see the **Gmail cooldown** section of the troubleshooting page. (Support reference: check Gmail Sent and run the send-path probe.)
