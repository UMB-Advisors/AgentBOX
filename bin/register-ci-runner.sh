#!/usr/bin/env bash
#
# One-time: register a GitHub Actions SELF-HOSTED runner on THIS workstation so
# the "Deploy dashboard" workflow (.github/workflows/deploy-dashboard.yml) can
# build + deploy on every merge to main. Run this ONCE per workstation.
#
# WHY a self-hosted runner: it runs as YOU, where Tailscale SSH to the boxes,
# your SSH keys, and the npm build env already work — so no SSH/Tailscale
# secrets need to live in GitHub. The workflow targets the label `agentbox-deploy`.
#
# GET A REGISTRATION TOKEN (expires in ~1h, so grab it right before running):
#   GitHub repo -> Settings -> Actions -> Runners -> "New self-hosted runner"
#   -> Linux/x64. Copy ONLY the token from the displayed `./config.sh --token <T>`.
#
# USAGE:
#   bin/register-ci-runner.sh <REGISTRATION_TOKEN> [runner-dir]
#
# REQUIREMENTS:
#   - Run as the user that has SSH access to the appliances (so deploys work).
#   - `sudo` available (the runner is installed as a boot service).
#
set -euo pipefail

TOKEN="${1:?Pass the registration token from GitHub repo Settings > Actions > Runners > New self-hosted runner}"
DIR="${2:-$HOME/actions-runner-agentbox}"
REPO_URL="https://github.com/UMB-Advisors/AgentBOX"
RUNNER_VERSION="${RUNNER_VERSION:-2.321.0}"   # bump if GitHub requires newer
LABEL="agentbox-deploy"

arch="$(uname -m)"
case "$arch" in
  x86_64) rarch=x64 ;;
  aarch64|arm64) rarch=arm64 ;;
  *) echo "!! unsupported arch: $arch" >&2; exit 1 ;;
esac

echo "==> Runner dir: $DIR  (repo: $REPO_URL, label: $LABEL, arch: $rarch)"
mkdir -p "$DIR"; cd "$DIR"

if [ ! -x ./config.sh ]; then
  url="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${rarch}-${RUNNER_VERSION}.tar.gz"
  echo "==> Downloading runner ${RUNNER_VERSION}"
  curl -fsSL -o runner.tar.gz "$url"
  tar xzf runner.tar.gz && rm -f runner.tar.gz
fi

echo "==> Configuring runner (label $LABEL, unattended)"
./config.sh --url "$REPO_URL" --token "$TOKEN" \
  --name "$(hostname)-agentbox" --labels "$LABEL" --unattended --replace

echo "==> Installing + starting as a boot service (runs as $USER)"
sudo ./svc.sh install "$USER"
sudo ./svc.sh start
sudo ./svc.sh status || true

cat <<EOF

==> Done. Runner '$(hostname)-agentbox' is online with label '$LABEL'.
    Verify: GitHub repo -> Settings -> Actions -> Runners (should show "Idle").
    From now on, merging to main triggers .github/workflows/deploy-dashboard.yml,
    which builds + deploys via bin/deploy-dashboard.sh. Stop deploying by hand.

    To remove later:  cd "$DIR" && sudo ./svc.sh stop && sudo ./svc.sh uninstall \\
                      && ./config.sh remove --token <new-removal-token>
EOF
