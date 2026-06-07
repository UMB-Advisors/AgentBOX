# Step 3: Operator profile

> Wizard route: `/onboarding/profile` — see `dashboard/app/onboarding/profile/page.tsx`

## What this step does

<!-- VOICEOVER: Tell us who is signing the email so drafts pick up your name, brand, and signoff. -->

- **What you see:** three short fields, each with an example — your first name, your brand or company name, and how you sign off your emails (for example, "Thanks, Sam"). 
- **What the appliance is doing:** it saves these three values as your personal settings so every draft it writes sounds like it came from you — your name, your company, your usual signoff.
- **What you need to do:** fill in the three fields and click Next. Don't overthink it — all three are editable later from the settings page, and the appliance also learns more of your style from your past emails after setup.

## Screenshots

<!-- SCREENSHOT: M1 onboarding /onboarding/profile on a phone — empty form, all three fields (first name / brand / signoff) visible -->
<!-- SCREENSHOT: M1 onboarding /onboarding/profile — filled-in example (e.g. Sam / Acme Co / "Thanks, Sam") -->

## Voiceover beats

<!-- VOICEOVER: hook — "Three fields and your drafts will already sound like you." (10-15 words) -->
<!-- VOICEOVER: action prompt — "Type your first name, your brand, and how you sign emails." -->
<!-- VOICEOVER: transition — "We'll quickly check the network before connecting your inbox." -->

## Common questions

**Can I change these later?** Yes. Everything here can be edited any time from the settings page after setup, under the persona/voice settings.

**What counts as my "brand"?** It's the company or business name your customers see when you email them — the name you'd want to appear in a signoff or signature. If you're a solo operator, your own name or business name is fine.

**Do I have to get my signoff exactly right?** No. Pick how you usually close emails ("Thanks", "Best", "Cheers, Sam"). The appliance treats this as a starting point and refines its sense of your style from your real sent mail later.

## What to do if it fails

**You clicked Next and got an error instead of moving to the network check.** The appliance couldn't save your profile. This is usually temporary:

1. Wait a moment and click Next again.
2. If it keeps failing, reload the page and re-enter the three fields.
3. If it still won't save, contact support — the box's database may need a quick check. (Support reference: confirm the `mailbox.persona` row exists and Postgres is healthy.)
