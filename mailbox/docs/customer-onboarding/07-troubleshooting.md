# What to do if it stops working

> A plain-English troubleshooting guide for the operator. No technical knowledge required.
> If anything here doesn't resolve it, contact support with the details below and we'll take over.

Most problems fall into one of five buckets. Start with the **status page** — it's the single best place to see what the appliance thinks is wrong:

> `https://<your-appliance-address>/dashboard/status`

The status page shows a row of coloured tiles. **Green** is healthy, **amber** means "keep an eye on it," and **red** means "this needs attention." Match the red tile to the section below.

---

## 1. No new drafts are appearing ("Classify lag")

**What you'll notice:** real new mail is sitting in your inbox, but nothing shows up in your queue.

**Check first:** the **Classify lag** tile on the status page.

- **Green** — the appliance is keeping up. The issue is probably that the mail isn't something it drafts replies for (newsletters, receipts, and obvious spam are skipped on purpose). No action needed.
- **Red** — the appliance has stopped processing incoming mail. This usually happens after an update or a power cycle, when the background workflows didn't restart in the "on" position.

**What you can try:**

1. Wait five minutes — the appliance checks mail on a five-minute cycle, so a brand-new email may simply not have been picked up yet.
2. Power-cycle the appliance: unplug it, wait ten seconds, plug it back in, and give it two minutes to come back up. Then reload the status page.
3. If the **Classify lag** tile is still red after that, contact support. The background workflows likely need to be switched back on.

> Support reference: this is the "inactive n8n workflow" failure mode — all four `MailBOX*` workflows must be active; run the `mailbox-n8n-verify` profile and restart n8n.

---

## 2. Replies aren't sending ("Gmail cooldown")

**What you'll notice:** you approve a draft, but it doesn't seem to send, and you may see a banner mentioning a Gmail cooldown or a paused state.

**What's happening:** Google limits how fast any app can send mail. If the appliance hits that limit, it deliberately pauses sending for a while to avoid making things worse. This is normal and temporary — your approved drafts are not lost; they wait until the pause lifts.

**What you can try:**

1. **Wait.** The banner shows when sending will resume. Let it pass on its own — this is the safe option.
2. **Do not** keep retrying the same draft during the pause. Each retry can extend the wait, so just leave it.
3. If you're sure the message already went out (for example, you see it in your Gmail **Sent** folder), you can stop worrying — the appliance is being cautious, not broken.

> There is a "Force resume" button on the cooldown banner, but only use it if support tells you to — clearing the pause too early makes Google extend it.

---

## 3. The appliance feels slow or stalls ("Memory pressure")

**What you'll notice:** drafts take much longer than usual, or processing seems to stall.

**Check first:** the **Memory pressure** tile on the status page.

- **Green** — plenty of headroom; the slowness is something else (try the network check below).
- **Amber** — the box is busy but coping. This often happens right after setup while it's learning from your past email. It usually clears within an hour.
- **Red** — the box is low on working memory and may be skipping or delaying work.

**What you can try:**

1. Give it time — amber usually clears on its own once the one-time catch-up work finishes.
2. If it's red and stays red, power-cycle the appliance (unplug, wait ten seconds, plug back in, wait two minutes).
3. If memory pressure is red right after a power cycle with nothing else running, see the next section — a leftover background process is the usual culprit.

---

## 4. Something's hogging the box ("Orphan containers")

**What you'll notice:** memory pressure stays red, or the box stays slow, even after a restart.

**Check first:** the **Orphan containers** tile on the status page. If it's red, it lists the names of any leftover background processes that shouldn't be running — usually left over from an update that didn't fully clean up.

**What you can try:**

1. Note the exact name(s) shown on the tile.
2. Power-cycle the appliance — a clean restart clears most leftovers.
3. If the same name reappears after the restart, send it to support. Knowing the exact name lets them stop it quickly and remotely.

> Support reference: orphan = running on the host but not declared in `docker-compose.yml`; `docker stop <name>` clears it. Often paired with the memory-pressure misdiagnosis class.

---

## 5. The dashboard won't load, or shows a security warning

**What you'll notice:** the dashboard address gives an error, a blank page, or a browser warning that the site isn't secure.

**Why this happens:** your appliance is reached over a secure web address that it sets up itself. Right after first plug-in — or right after a network change — that secure address can take a couple of minutes to come online.

**What you can try:**

1. Confirm you typed the exact address you were given, including `https://`.
2. Wait two minutes after plug-in (or after any network change) and reload.
3. Confirm the appliance is powered on and your device can reach the internet / the same network.
4. If a security warning persists past five minutes, contact support — the secure certificate may not have been issued.

> **A note on access:** your dashboard is protected by the password you set in Step 2. Anyone reaching the address must enter it. If support ever discusses whether the appliance should be reachable from outside your local network, that's a deliberate setup choice (the "public exposure" decision) — leave it as configured at install unless support guides you to change it. Opening it up wider than needed is the main thing to avoid.

---

## When to contact support

Reach out to support if:

- A red status tile stays red after a power-cycle and the steps above.
- Replies still won't send a full day after a Gmail cooldown banner cleared.
- You see a security warning that doesn't go away within five minutes.
- Anything here mentions a "support reference" and the simple steps didn't fix it.

**What to include:** which status tile is red (and its colour), the exact address you're using, a screenshot of any error or banner, and roughly when it started. That's enough for support to pick it up quickly.
