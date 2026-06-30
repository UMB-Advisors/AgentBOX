# Bundled Hermes plugins (preloaded on a fresh AgentBOX)

Plugin payloads seeded into `~/.hermes/plugins/` by `install/agentbox-install.sh`
(STAGE 7.7) and enabled via `hermes plugins enable`.

## agency-agents-router

A lazy-router over a curated slice of **The Agency** agent roster
(<https://github.com/msitarzewski/agency-agents>, MIT — see
`agency-agents-router/LICENSE.upstream`). It exposes four tools to the agent —
`agency_agents_search` / `agency_agents_inspect` / `agency_agents_load` /
`agency_agents_delegate` — and keeps the roster in `data/agents.json` so the
135 specialists never bloat the initial skill catalog; the agent finds and
loads a specialist on demand ("use the Frontend Developer").

**Curated divisions** (11 of 16): design, engineering, finance, marketing,
paid-media, product, project-management, sales, security, support, testing.
Dropped: academic, game-development, gis, spatial-computing, specialized.

**Regenerate** (e.g. to re-curate or refresh from upstream):

```bash
git clone --depth 1 https://github.com/msitarzewski/agency-agents /tmp/aa
# remove unwanted division dirs from /tmp/aa, then:
python3 /tmp/aa/scripts/build-hermes-plugin.py --repo-root /tmp/aa --out /tmp/aa-out
cp -a /tmp/aa-out/agency-agents-router provisioning/plugins/
```
