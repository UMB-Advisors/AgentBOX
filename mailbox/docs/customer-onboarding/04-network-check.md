# Step 4: Network check

> Wizard route: `/onboarding/network-check` — see `dashboard/app/onboarding/network-check/page.tsx`

## What this step does

<!-- VOICEOVER: We'll verify the appliance can reach Gmail and the cloud drafter before you connect email. -->

- **What you see:** a short checklist of three items — **Gmail**, **dashboard certificate**, and **cloud drafter** — each turning into a green tick when it passes or a red X with a short fix hint if it doesn't. It takes about five seconds.
- **What the appliance is doing:** it quietly tests three connections — that it can reach Google's Gmail service, that its own secure web address is working, and that it can reach the cloud writing service used for trickier emails.
- **What you need to do:** wait for the three green ticks, then click Next. If any row is red, follow the short hint shown next to it before continuing.

## Screenshots

<!-- SCREENSHOT: M1 onboarding /onboarding/network-check — all three rows green (passing state) -->
<!-- SCREENSHOT: M1 onboarding /onboarding/network-check — dashboard-certificate row red, with the inline remediation hint visible -->

## Voiceover beats

<!-- VOICEOVER: hook — "Five seconds to make sure the box can talk to the internet." (10-15 words) -->
<!-- VOICEOVER: action prompt — "Wait for the three green ticks, then tap Next." -->
<!-- VOICEOVER: transition — "Now let's connect your inbox." -->

## Common questions

**What does each check mean?**

- **Gmail** — the box can reach Google to read and send your mail.
- **Dashboard certificate** — your secure web address is live and trusted, so the dashboard loads without warnings.
- **Cloud drafter** — the box can reach the cloud writing service it uses for the trickiest emails. (Most everyday drafts are written on the box itself; this is the safety net.)

**What if the Gmail check fails?** It's usually your internet connection or a temporary Google issue. Confirm the appliance's network connection is working, wait a minute, and re-run the check.

**What if the certificate check fails?** The appliance's secure address may not have finished setting up yet — this can take a couple of minutes right after first plug-in. Wait two minutes and re-run the check.

## What to do if it fails

Re-run the check first (reload the step). If a row is still red after a couple of minutes:

| Red row | Most likely cause | What to try |
| --- | --- | --- |
| **Gmail** | No internet, or a brief Google outage | Check the appliance's network/Wi-Fi or cable; wait a minute and re-run. Confirm other devices on the same network can reach the internet. |
| **Dashboard certificate** | Secure address still being set up, or a DNS delay | Wait two minutes after first plug-in, then re-run. If it's still red after five minutes, contact support — the certificate may not have been issued. |
| **Cloud drafter** | Missing or invalid cloud key | This usually means the cloud writing key wasn't set during install. The box can still run on its own, but contact support to enable the cloud safety net. |

If two or more rows are red, it's almost always the network — confirm the appliance is online before troubleshooting anything else.
