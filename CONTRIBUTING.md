# Contributing to AgentBOX

Thanks for your interest in AgentBOX — the source-of-truth monorepo for the
edge-AI appliance (the MailBOX email pipeline + the Hermes agent + gBrain,
co-resident on one Jetson, fronted by the sidecar). This guide covers how to
report issues, propose changes, and get a pull request merged.

AgentBOX is developed by [UMB Advisors](https://github.com/UMB-Advisors). The
code is proprietary (see [`README.md`](README.md#license)); the repository is
public so operators and researchers can read it, file issues, and coordinate
security reports.

## Code of Conduct

Be respectful and constructive. We follow the spirit of the
[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/):
no harassment, no personal attacks, assume good faith. Conduct concerns can be
raised privately to the maintainers at **conduct@umbadvisors.com**.

## Where changes belong (read this first)

AgentBOX is a monorepo with a strict split — putting a change in the wrong place
is the most common wasted PR:

- **Custom operator features and the user-facing UI do NOT go here.** They live
  in [`UMB-Advisors/agentbox-sidecar`](https://github.com/UMB-Advisors/agentbox-sidecar)
  (the FastAPI sidecar on `:9200`). **Never** patch Hermes (`web_server.py` /
  `hermes_cli`) for features.
- **This repo owns** the vendored MailBOX stack (`mailbox/`), the installer
  (`install/`), provisioning (`provisioning/`), the Hermes/gBrain wiring
  (`config/`), boot units (`systemd/`), and the appliance docs (`docs/`).
- **Hermes itself stays stock.** The pin is managed in
  [`agentbox-hermes-patches`](https://github.com/UMB-Advisors/agentbox-hermes-patches);
  don't fork it here.

See [`CLAUDE.md`](CLAUDE.md) and [`README.md`](README.md#repository-layout) for the
full layout.

## Reporting bugs and requesting features

- **Security vulnerabilities:** do **not** open a public issue. Follow
  [`SECURITY.md`](SECURITY.md) (GitHub private vulnerability reporting or
  security@umbadvisors.com).
- **Bugs / features:** open a [GitHub issue](https://github.com/UMB-Advisors/AgentBOX/issues).
  Include the appliance build / `main` SHA, the Hermes pin if relevant, what you
  expected, what happened, and steps to reproduce. For appliance behavior,
  include the relevant liveness output (`curl -s 127.0.0.1:9200/healthz`).

(Internal contributors: work is tracked in Linear team **MBOX** / project
**AgentBOX**; reference the `MBOX-###` id in the PR when there is one.)

## Development setup

This is an **appliance / install repo** — mostly bash plus vendored services, so
there is no single test command. The pieces you are most likely to touch:

```bash
# Shell scripts (installer / provisioning) — must stay syntax-clean and
# shellcheck-clean (this is what CI gates on):
bash -n install/agentbox-install.sh
for f in provisioning/*.sh mailbox/scripts/*.sh; do bash -n "$f"; done
shellcheck -x --severity=warning install/agentbox-install.sh

# MailBOX dashboard (Node) — the one subtree with a real test suite:
cd mailbox/dashboard
npm ci
npm run lint         # Biome
npm run typecheck    # tsc
npm test             # Vitest (needs a Postgres; see .github/workflows/ci.yml)
```

A full appliance bring-up (`install/agentbox-install.sh --prototype`) runs **on a
Jetson**, not in CI — see [`README.md`](README.md#getting-started) and
[`docs/agentbox-jp72-reproduction.v0.1.0.md`](docs/agentbox-jp72-reproduction.v0.1.0.md).

## Pull request process

1. **Branch** off `main` using a Conventional-Commits-style prefix:
   `feat/...`, `fix/...`, `docs/...`, `chore/...`. `main` is protected — open a PR;
   don't push to it directly.
2. **Keep PRs focused.** One logical change per PR. Respect the repo split above.
3. **Write [Conventional Commits](https://www.conventionalcommits.org/)** — the
   history uses them (`feat(web): ...`, `fix: ...`, `docs: ...`). Scope is
   encouraged (`feat(installer): ...`).
4. **Make CI green.** The [CI workflow](.github/workflows/ci.yml) runs the
   dashboard job (Biome + tsc + Vitest) and a `bash -n` + shellcheck job over the
   install/provisioning scripts. Run the relevant checks locally first.
5. **Update docs** when you change behavior — especially the runbooks and any
   version pin (the Hermes pin lives in one place; keep the README/`CLAUDE.md`
   references in sync).
6. **Open the PR** against `main` with a clear description of what and why, and
   how you verified it (commands + output). Link the issue / `MBOX-###`.

Maintainers review, may request changes, and merge once CI is green and the
change fits the appliance's boundaries.

## AI-assisted contributions

AI tools are welcome in the workflow, but **there must be a human in the loop**:
you are responsible for understanding, testing, and standing behind every line
you submit. PRs that are clearly unreviewed machine output will be asked for
rework.

## Licensing of contributions

AgentBOX is proprietary. External code contributions are accepted at the
maintainers' discretion, and by opening a pull request you agree that your
contribution may be used and distributed under the repository's license terms.
If you are unsure whether a change is in scope, open an issue to discuss before
investing in a PR.

Thanks for helping make AgentBOX better.
