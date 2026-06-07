# Step 2: Set admin password

> Wizard route: `/onboarding/password` — see `dashboard/app/onboarding/password/page.tsx`

## What this step does

<!-- VOICEOVER: Pick the password the appliance will use to gate the dashboard and the n8n editor. -->

- **What you see:** a username (pre-filled as `admin`), a password field with a strength meter, and a confirm-password field. The **Next** button stays disabled until the password is strong enough and both fields match.
- **What the appliance is doing:** when you click Next, the appliance scrambles (hashes) the password on the box itself and stores only the scrambled version — it never keeps the password in plain text and never sends it anywhere. It then refreshes the lock on the dashboard so your new password takes effect.
- **What you need to do:** choose a strong password you'll remember (a password manager is ideal), confirm it, and click Next. This is the one password that protects your appliance, so keep it somewhere safe.

## Screenshots

<!-- SCREENSHOT: M1 onboarding /onboarding/password — form just loaded, username "admin" pre-filled, password fields empty -->
<!-- SCREENSHOT: M1 onboarding /onboarding/password — weak-password state, strength meter low and validation message visible -->
<!-- SCREENSHOT: M1 onboarding /onboarding/password — brief success/loading state after clicking Next, before redirect to Step 3 -->

## Voiceover beats

<!-- VOICEOVER: hook — "This password gates everything Staqs can't see." (10-15 words) -->
<!-- VOICEOVER: action prompt — "Pick a strong password and confirm it." -->
<!-- VOICEOVER: transition — "Now let's tell the appliance who you are." -->

## Common questions

**What if I lose this password?** It can't be recovered from the appliance — only a scrambled version is stored, by design. If you lose it, contact support; resetting it requires secure access to the box and takes a few minutes.

**Can I use a password manager?** Yes, and we recommend it. Generate a long random password, save it in your manager, and paste it into both fields.

**What is this password for, exactly?** It's the single login that protects your dashboard (where you approve email drafts) and the behind-the-scenes workflow editor. It is separate from your Google/Gmail password — you'll connect Gmail in Step 5.

## What to do if it fails

**The Next button stays greyed out.** Your password isn't strong enough yet or the two fields don't match. Make it longer (a mix of letters, numbers, and symbols), and re-type the confirm field exactly.

**You clicked Next and saw an error instead of moving to Step 3.** The appliance couldn't save the password. This is almost always a temporary hiccup:

1. Wait a few seconds and click Next again.
2. If it keeps failing, reload the page. The password is only saved once you reach Step 3, so it's safe to retry.
3. If you can still log in elsewhere but the change won't stick, contact support — the box's storage or the lock-refresh step may need a restart. (Support reference: confirm Postgres is healthy and re-run `docker compose up -d caddy`.)
