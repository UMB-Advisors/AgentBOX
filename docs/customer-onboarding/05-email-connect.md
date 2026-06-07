# Step 5: Connect Gmail

> Wizard route: `/onboarding/email-connect` — see `dashboard/app/onboarding/email-connect/page.tsx`

## What this step does

<!-- VOICEOVER: Authorize the appliance to read your inbox and send replies on your behalf. -->

- **What you see:** a single **Connect Gmail** button. Clicking it sends you to Google's standard consent screen, where you sign in and approve access. Google then sends you back to the wizard, which shows "Connected as you@yourcompany.com".
- **What the appliance is doing:** it completes Google's secure sign-in handshake and stores a connection token on the box so it can read new mail and send your approved replies. Your Google password is never seen or stored by the appliance.
- **What you need to do:** click **Connect Gmail**, sign in with the Google account for the inbox you want managed, and approve the requested permissions. Heads up: until our app finishes Google's verification review, you may see an "unverified app" notice — that's expected (see the question below).

## Screenshots

<!-- SCREENSHOT: M1 onboarding /onboarding/email-connect — initial state, single "Connect Gmail" button -->
<!-- SCREENSHOT: Google consent screen reached from M1 — annotated to show the "unverified app" warning and where to click Advanced -> Continue -->
<!-- SCREENSHOT: M1 onboarding /onboarding/email-connect — return/success state, "Connected as you@yourcompany.com" -->

## Voiceover beats

<!-- VOICEOVER: hook — "One Google consent screen and you're connected." (10-15 words) -->
<!-- VOICEOVER: action prompt — "Click Connect Gmail and approve the requested permissions." -->
<!-- VOICEOVER: warning — "You may see an 'unverified app' notice — click 'Advanced' then continue. We're working on getting that cleared." -->
<!-- VOICEOVER: transition — "Almost done." -->

## Common questions

**What permissions am I granting?** Three: read your inbox (so it can triage incoming mail), send mail (so it can send the replies you approve), and read your basic Google profile (your name and address). It does not delete mail or change your settings.

**Why does it say "unverified app"?** Our connection app is still going through Google's formal verification review. Until that's complete, Google shows a caution notice. To continue, click **Advanced**, then **Continue to (app name)**. This is safe — the app only ever requests the three permissions above. We'll remove this notice once Google's review clears.

**Can I disconnect this later?** Yes, any time, from your Google Account security settings under "Third-party access." Doing so simply stops the appliance from reading or sending mail.

**Do I have to use the laptop for this?** It's a little easier on a laptop because the Google screen is roomier, but a phone works fine too.

## What to do if it fails

**The consent screen never appeared, or you weren't sent back to the wizard.**

1. Make sure pop-ups aren't blocked for this site, then click **Connect Gmail** again.
2. If you got stuck on the "unverified app" notice, that's normal — click **Advanced**, then **Continue**. (Don't close the tab.)
3. Sign in with the correct Google account — it must be the inbox you want the appliance to manage.

**It said it connected, but later steps complain it can't reach your mail.** The connection may not have saved cleanly. Return to this step and click **Connect Gmail** again to redo the sign-in. If it still fails, contact support — the connection store may need a quick reset. (Support reference: check the connection details/credential in the workflow editor and the n8n container logs.)
