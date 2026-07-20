# Security Policy

AgentBOX is an edge-AI appliance: a self-hosted agent, its long-term memory
(gBrain), the MailBOX email pipeline, and the operator sidecar, co-resident on a
single Jetson. It is **local-first and single-tenant** — one organization owns
the box, its data, its model credentials, and its logs. We take security of that
boundary seriously and appreciate reports that help us keep it tight.

## Supported Versions

AgentBOX ships as a provisioned appliance image rather than a downloadable
library, so "supported" means the code that lands on a box:

| What | Supported |
|------|-----------|
| `main` (source of truth for new appliance builds) | ✅ Yes |
| The most recent tagged release | ✅ Yes |
| Vendored **Hermes agent** pin (currently `v0.18.2` / `v2026.7.7.2`) | ✅ Security fixes tracked via the pin in [`UMB-Advisors/agentbox-hermes-patches`](https://github.com/UMB-Advisors/agentbox-hermes-patches) |
| Older provisioned boxes | ⚠️ Update via `docs/hermes-upgrade-runbook.v0.1.0.md` and the installer before reporting |

If you are running an older appliance, please confirm the issue reproduces on a
current `main` build where practical before reporting.

## Reporting a Vulnerability

**Please do not open a public GitHub issue, discussion, or pull request for a
security vulnerability.** Public disclosure before a fix puts every deployed box
at risk.

Use one of these private channels instead:

1. **Preferred — GitHub private vulnerability reporting.** Go to the
   [**Security** tab](https://github.com/UMB-Advisors/AgentBOX/security) →
   **Report a vulnerability**. This opens a private advisory visible only to you
   and the maintainers.
2. **Email.** If you cannot use the GitHub tool, email
   **security@umbadvisors.com** with the details below. Encrypt if you can; ask
   for a key in a first, low-detail message if needed.

### What to include

A good report lets us reproduce and triage quickly. Please include:

- **Affected component** (sidecar, Hermes agent, gBrain, MailBOX pipeline,
  provisioning/installer) and the **file path + line range**.
- **Version / commit**: appliance build or `main` commit SHA, and the Hermes pin
  if relevant (`~/.hermes/hermes-agent-v2` reports its version).
- **Environment**: OS/JetPack, Python/Node versions where relevant.
- **Reproduction steps** and a proof-of-concept if you have one.
- **Impact** and the **trust boundary crossed** (e.g. gateway user → host, one
  role → another, network → loopback-only service).
- **Whether a governance, approval, folder-policy, or access-control check was
  bypassed** — this is the highest-signal detail for an appliance whose whole job
  is enforcing those boundaries.

Please describe the defect and its impact rather than including weaponized or
destructive payloads.

### What to expect

- **Acknowledgement** within **3 business days**.
- An initial **assessment and severity** within **10 business days**.
- We will keep you updated as we work on a fix, and we practice **coordinated
  disclosure**: we ask that you give us a reasonable window (typically up to
  **90 days**) to remediate before any public write-up, and we are happy to
  credit you in the advisory unless you prefer to stay anonymous.

## Upstream Hermes

AgentBOX runs **stock upstream** [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent)
behind the sidecar (the only carried patch is a `/dashboard` reverse-proxy). If a
vulnerability lives in unmodified upstream Hermes rather than in AgentBOX's
integration, please **also** report it upstream so every Hermes deployment
benefits, and preserve upstream's coordinated-disclosure expectations. Let us
know in your report if you have done so; we will coordinate on the pin bump.

## Scope

**In scope:** the AgentBOX integration — the sidecar, provisioning/installer,
Hermes/gBrain wiring, the compose override and boot units, the MailBOX pipeline
as vendored here, and the appliance's trust boundaries (identity, access control,
network exposure, secret handling).

**Out of scope / lower priority:** issues that require an already-compromised host
or physical access to the box; vulnerabilities solely in third-party dependencies
with no AgentBOX-reachable impact (report those upstream, but do tell us so we can
bump); and findings against a box that is out of date relative to `main`.

## Safe Harbor

We will not pursue or support legal action against researchers who, in good
faith, follow this policy: test only against boxes you own or are authorized to
test, avoid privacy violations and service disruption, and give us a reasonable
time to remediate before disclosure.

Thank you for helping keep AgentBOX and the people who rely on it safe.
