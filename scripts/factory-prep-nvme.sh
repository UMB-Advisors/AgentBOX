#!/usr/bin/env bash
# factory-prep-nvme.sh — personalize a dd-restored NVMe for a specific customer
#
# PURPOSE: Personalize a freshly-dd'd NVMe (loaded with a golden image from
# factory-image.sh) for a specific customer before packing. Runs on the
# workstation — the NVMe is in a USB-NVMe adapter or spare M.2 slot.
# Mounts the NVMe rootfs, regenerates per-host identity (hostname, /etc/hosts,
# SSH host key slot, Tailscale state, journals, bash history), and stamps the
# customer slug into /etc/mailbox-customer for the appliance's .env loader to
# read at boot. STAQPRO-409.
#
# ──────────────────────────────────────────────────────────────────────────────
# USAGE
#   ./scripts/factory-prep-nvme.sh [--dry-run] [--yes] [--mount-point <path>] \
#       --slug <customer-slug> (--device <path> | --by-id <path>)
#
#   --slug         Customer slug (DNS-label-safe: lowercase alphanum + hyphens,
#                  2-32 chars, no leading/trailing hyphen). Becomes the hostname
#                  and /etc/mailbox-customer value. Same regex as provision-customer-dns.sh.
#   --device       Full NVMe device path (e.g. /dev/nvme1n1). Prefer --by-id.
#   --by-id        Stable by-id symlink (e.g. /dev/disk/by-id/nvme-Kingston_SNV3...).
#                  Safer — names don't shift between reboots.
#   --mount-point  Where to mount the rootfs partition (default: auto-created
#                  temp dir under /tmp, cleaned up on exit).
#   --env-path     Path to the appliance repo .env RELATIVE to the rootfs
#                  (default: home/bob/mailbox/.env). When that file exists on
#                  the NVMe, MAILBOX_LAN_HOSTNAME=<slug>.local is written/updated
#                  in place (idempotent) so docker-compose serves the per-customer
#                  mDNS hostname on first `up`. Absent file → warn, skip (the
#                  provisioning runbook seeds .env from .env.example later).
#   --dry-run      Print planned action and exit 0 — no mounts, no writes.
#   --yes          Skip the interactive confirmation prompt (require literal YES).
#
# EXAMPLES
#   # Identify the target NVMe first
#   lsblk && ls -l /dev/disk/by-id/ | grep nvme
#
#   # Dry-run preview (always do this first)
#   sudo ./scripts/factory-prep-nvme.sh --dry-run \
#       --slug acme --by-id /dev/disk/by-id/nvme-Kingston_SNV3S1000G_12345678
#
#   # Real personalization (operator types YES at the prompt)
#   sudo ./scripts/factory-prep-nvme.sh \
#       --slug acme --by-id /dev/disk/by-id/nvme-Kingston_SNV3S1000G_12345678
#
#   # Non-interactive (scripted)
#   sudo ./scripts/factory-prep-nvme.sh --yes \
#       --slug heronlabs --device /dev/nvme1n1
#
# REQUIRED ENV / PRE-CONDITIONS
#   - Must run as root (sudo)
#   - NVMe must NOT be the workstation's root disk
#   - NVMe must have been dd'd from a valid MailBOX golden image (ext4 rootfs partition)
#   - lsblk, findmnt, mount, umount available (util-linux, present on Ubuntu 22.04)
#
# EXIT CODES
#   0  success
#   1  bad invocation / missing root
#   2  validation failure (bad slug, no ext4 partition, device not a block device)
#   3  safety gate tripped (root-device match, partition mounted on workstation, user declined)
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROG="$(basename "$0")"

# ── defaults ──────────────────────────────────────────────────────────────────
DRY_RUN=0
YES=0
SLUG=""
DEVICE=""
BY_ID=""
MOUNT_POINT_ARG=""
# Repo .env path relative to the rootfs. Matches the M1 layout
# (/home/bob/mailbox/.env per root CLAUDE.md → Deploy flow). Overridable
# via --env-path if a golden image uses a different repo location.
ENV_REL_PATH="home/bob/mailbox/.env"

usage() {
  sed -n '/^# USAGE/,/^# EXAMPLES/{ /^# EXAMPLES/d; s/^# \{0,1\}//; p }' "$0"
}

# ── arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      DRY_RUN=1; shift ;;
    --yes)          YES=1; shift ;;
    --slug)         SLUG="${2:?--slug requires a value}"; shift 2 ;;
    --device)       DEVICE="${2:?--device requires a path}"; shift 2 ;;
    --by-id)        BY_ID="${2:?--by-id requires a path}"; shift 2 ;;
    --mount-point)  MOUNT_POINT_ARG="${2:?--mount-point requires a path}"; shift 2 ;;
    --env-path)     ENV_REL_PATH="${2:?--env-path requires a path}"; shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    -*)             echo "$PROG: unknown flag: $1" >&2; usage >&2; exit 1 ;;
    *)              echo "$PROG: unexpected argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# ── root check ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: $PROG must run as root (use sudo)." >&2
  exit 1
fi

# ── slug required and validated ───────────────────────────────────────────────
if [[ -z "$SLUG" ]]; then
  echo "ERROR: --slug is required." >&2
  usage >&2
  exit 1
fi

# DNS-label-safe: lowercase alphanum + hyphens, 2-32 chars, no leading/trailing hyphen.
# Must start AND end with [a-z0-9], hence the full pattern ^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$
# which requires minimum 2 chars (one at start + one at end, zero middle chars).
if ! [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$ ]]; then
  echo "ERROR: --slug '$SLUG' is not a valid customer slug." >&2
  echo "       Required: lowercase letters/digits/hyphens, 2-32 chars," >&2
  echo "                 must not start or end with a hyphen." >&2
  echo "       Examples: acme, heron-labs, staqs, my-customer" >&2
  exit 2
fi

# ── device: require exactly one of --device / --by-id ────────────────────────
if [[ -z "$DEVICE" && -z "$BY_ID" ]]; then
  echo "ERROR: one of --device or --by-id is required." >&2
  usage >&2
  exit 1
fi
if [[ -n "$DEVICE" && -n "$BY_ID" ]]; then
  echo "ERROR: specify either --device or --by-id, not both." >&2
  exit 1
fi

# ── resolve to canonical device path ──────────────────────────────────────────
if [[ -n "$BY_ID" ]]; then
  DEVICE="$(readlink -f "$BY_ID")"
fi

# ── validate device is a block device ────────────────────────────────────────
if [[ ! -b "$DEVICE" ]]; then
  echo "ERROR: device '$DEVICE' is not a block device." >&2
  echo "       Run 'lsblk' and 'ls -l /dev/disk/by-id/ | grep nvme' to identify the NVMe." >&2
  exit 2
fi

# ── identify the whole-disk for this device ──────────────────────────────────
# User may pass a whole-disk path (/dev/nvme1n1) or a partition (/dev/nvme1n1p1).
DEVICE_PARENT_NAME="$(lsblk -no PKNAME "$DEVICE" 2>/dev/null | head -1 || true)"
if [[ -z "$DEVICE_PARENT_NAME" ]]; then
  # PKNAME empty means DEVICE itself is a whole disk
  TARGET_DISK="$DEVICE"
else
  TARGET_DISK="/dev/${DEVICE_PARENT_NAME}"
fi

# ── safety gate 1: target must not match the workstation root disk ────────────
ROOT_SRC="$(findmnt -no SOURCE /)"
ROOT_PARENT_NAME="$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null | head -1 || true)"
if [[ -z "$ROOT_PARENT_NAME" ]]; then
  ROOT_DISK="$ROOT_SRC"
else
  ROOT_DISK="/dev/${ROOT_PARENT_NAME}"
fi

TARGET_DISK_RESOLVED="$(readlink -f "$TARGET_DISK" || echo "$TARGET_DISK")"
ROOT_DISK_RESOLVED="$(readlink -f "$ROOT_DISK" || echo "$ROOT_DISK")"

if [[ "$TARGET_DISK_RESOLVED" == "$ROOT_DISK_RESOLVED" ]]; then
  echo "REFUSED: target device '$TARGET_DISK' is the workstation's root disk '$ROOT_DISK_RESOLVED'." >&2
  echo "         Re-verify with 'lsblk' — ensure the target is the customer NVMe, not the system disk." >&2
  exit 3
fi

# ── safety gate 2: no partition of target disk mounted as / or /boot ─────────
# Get all partition paths under the target disk and check if any are mounted as / or /boot.
MOUNTED_AS_ROOT_OR_BOOT="$(lsblk -lnpo NAME "$TARGET_DISK" 2>/dev/null | \
  while read -r part; do findmnt -no TARGET "$part" 2>/dev/null || true; done | \
  grep -E '^/$|^/boot' || true)"

if [[ -n "$MOUNTED_AS_ROOT_OR_BOOT" ]]; then
  echo "REFUSED: a partition of '$TARGET_DISK' is currently mounted as:" >&2
  echo "         $MOUNTED_AS_ROOT_OR_BOOT" >&2
  echo "         Unmount it first, then re-run this script." >&2
  exit 3
fi

# ── find rootfs partition: largest ext4 partition on target disk ──────────────
ROOTFS_PART="$(lsblk -lnpo NAME,FSTYPE,SIZE "$TARGET_DISK" 2>/dev/null | \
  awk '$2=="ext4"' | sort -k3 -h | tail -1 | awk '{print $1}' || true)"

if [[ -z "$ROOTFS_PART" ]]; then
  echo "ERROR: no ext4 partition found on '$TARGET_DISK'." >&2
  echo "       Was this NVMe dd'd from a valid MailBOX golden image?" >&2
  echo "       Run 'lsblk -o NAME,FSTYPE,SIZE $TARGET_DISK' to inspect." >&2
  exit 2
fi

# ── mount point ───────────────────────────────────────────────────────────────
if [[ -n "$MOUNT_POINT_ARG" ]]; then
  MNT="$MOUNT_POINT_ARG"
  CLEANUP_MNT=0
else
  MNT="$(mktemp -d -t mailbox-nvme-XXXXXX)"
  CLEANUP_MNT=1
fi

# ── print intended action ─────────────────────────────────────────────────────
echo "→ factory-prep-nvme.sh — NVMe personalization plan"
echo "  Customer slug      : $SLUG"
echo "  Target disk        : $TARGET_DISK"
echo "  Rootfs partition   : $ROOTFS_PART"
echo "  Mount point        : $MNT"
echo "  Files to be set    :"
echo "    /etc/hostname        → '$SLUG'"
echo "    /etc/hosts           → 127.0.1.1 entry updated to '$SLUG'"
echo "    /etc/mailbox-customer → '$SLUG' (with prep timestamp)"
echo "    ${ENV_REL_PATH} (relative to rootfs) → MAILBOX_LAN_HOSTNAME=${SLUG}.local (if present)"
echo "    /etc/ssh/ssh_host_*  → deleted (keys regenerated on first boot)"
echo "    /etc/ssh/regenerate-on-boot → marker file created"
echo "    /var/lib/tailscale/tailscaled.state → deleted"
echo "    /var/log/journal/*   → cleared"
echo "    /var/log/syslog*     → cleared"
echo "    /var/log/auth.log*   → cleared"
echo "    /var/log/dmesg*      → cleared"
echo "    /root/.bash_history  → deleted"
echo "    /home/*/.bash_history, .lesshst, .viminfo, .python_history → deleted"

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "Dry run complete. No mounts, no writes. Rerun without --dry-run to personalize."
  # Clean up temp dir if we created it (nothing was mounted)
  if [[ $CLEANUP_MNT -eq 1 ]]; then
    rmdir "$MNT" 2>/dev/null || true
  fi
  exit 0
fi

# ── confirmation ──────────────────────────────────────────────────────────────
echo
echo "WARNING: This will MODIFY '$TARGET_DISK' — identity data will be wiped and"
echo "         the slug '$SLUG' will be stamped. This is irreversible."
echo

if [[ $YES -ne 1 ]]; then
  read -r -p "Type 'YES' to proceed: " confirm
  if [[ "$confirm" != "YES" ]]; then
    echo "Aborted by user."
    if [[ $CLEANUP_MNT -eq 1 ]]; then
      rmdir "$MNT" 2>/dev/null || true
    fi
    exit 3
  fi
fi

# ── mount + trap (THE safety net from feedback_probe_cleanup_trap) ────────────
mount "$ROOTFS_PART" "$MNT"
trap 'sync; umount "$MNT" 2>/dev/null || true; if [[ "${CLEANUP_MNT:-0}" -eq 1 ]]; then rmdir "$MNT" 2>/dev/null || true; fi' EXIT

echo "→ Mounted $ROOTFS_PART at $MNT"

# ── helper: log personalization steps ────────────────────────────────────────
personalize_log() {
  echo "[personalize] $*"
}

# ── personalization: hostname ─────────────────────────────────────────────────
personalize_log "Setting hostname to '$SLUG'"
echo "$SLUG" > "$MNT/etc/hostname"

personalize_log "Updating /etc/hosts 127.0.1.1 entry"
if grep -qE '^127\.0\.1\.1\s' "$MNT/etc/hosts" 2>/dev/null; then
  sed -i -E "s/^127\.0\.1\.1[[:space:]]+.*/127.0.1.1\t${SLUG}/" "$MNT/etc/hosts"
else
  printf '127.0.1.1\t%s\n' "$SLUG" >> "$MNT/etc/hosts"
fi

# ── personalization: SSH host keys ────────────────────────────────────────────
personalize_log "Removing SSH host keys (regenerated on first boot by sshd)"
rm -f "$MNT"/etc/ssh/ssh_host_* 2>/dev/null || true
# Marker file: lets the operator confirm via filesystem inspection that prep ran.
touch "$MNT/etc/ssh/regenerate-on-boot"

# ── personalization: Tailscale identity ──────────────────────────────────────
personalize_log "Clearing Tailscale identity"
rm -f "$MNT/var/lib/tailscale/tailscaled.state" 2>/dev/null || true
rm -f "$MNT"/var/lib/tailscale/tailscaled.log* 2>/dev/null || true
# Leave tailscale directory and tailscaled.sock (recreated at runtime)

# ── personalization: journals and logs ───────────────────────────────────────
personalize_log "Clearing system logs and journals"
rm -rf "$MNT/var/log/journal"/* 2>/dev/null || true
rm -f "$MNT"/var/log/syslog* 2>/dev/null || true
rm -f "$MNT"/var/log/auth.log* 2>/dev/null || true
rm -f "$MNT"/var/log/dmesg* 2>/dev/null || true

# ── personalization: bash and user histories ──────────────────────────────────
personalize_log "Clearing bash history and user session artifacts"
rm -f "$MNT/root/.bash_history" 2>/dev/null || true
for user_home in "$MNT"/home/*/; do
  [[ -d "$user_home" ]] || continue
  rm -f "${user_home}.bash_history" "${user_home}.lesshst" \
        "${user_home}.viminfo" "${user_home}.python_history" 2>/dev/null || true
done

# ── personalization: customer slug stamp ──────────────────────────────────────
personalize_log "Stamping /etc/mailbox-customer with slug '$SLUG'"
printf '# Set by factory-prep-nvme.sh on %s\n%s\n' "$(date -Iseconds)" "$SLUG" \
  > "$MNT/etc/mailbox-customer"

# ── personalization: per-customer LAN hostname (MBOX-158) ─────────────────────
# docker-compose interpolates MAILBOX_LAN_HOSTNAME into the Caddy LAN listener
# (STAQPRO-410). Write/update it here so the appliance serves
# https://<slug>.local/ on first `up` without a manual .env edit. Idempotent:
# update the key in place if present, append otherwise. Skip (warn) if the repo
# .env isn't on the NVMe — the provisioning runbook seeds it from .env.example.
ENV_REL_PATH_CLEAN="${ENV_REL_PATH#/}"
NVME_ENV_PATH="$MNT/$ENV_REL_PATH_CLEAN"
LAN_HOSTNAME_LINE="MAILBOX_LAN_HOSTNAME=${SLUG}.local"
if [[ -f "$NVME_ENV_PATH" ]]; then
  personalize_log "Setting $LAN_HOSTNAME_LINE in $ENV_REL_PATH_CLEAN"
  if grep -qE '^[[:space:]]*MAILBOX_LAN_HOSTNAME=' "$NVME_ENV_PATH"; then
    sed -i -E "s|^[[:space:]]*MAILBOX_LAN_HOSTNAME=.*|${LAN_HOSTNAME_LINE}|" "$NVME_ENV_PATH"
  else
    printf '%s\n' "$LAN_HOSTNAME_LINE" >> "$NVME_ENV_PATH"
  fi
else
  personalize_log "WARN: $ENV_REL_PATH_CLEAN not found on NVMe — skipping MAILBOX_LAN_HOSTNAME."
  personalize_log "      Set '$LAN_HOSTNAME_LINE' during provisioning (see .env.example)."
fi

# ── personalization: permissions ──────────────────────────────────────────────
personalize_log "Setting permissions on modified files"
chmod 0644 "$MNT/etc/hostname" "$MNT/etc/hosts" "$MNT/etc/mailbox-customer"
chown 0:0 "$MNT/etc/hostname" "$MNT/etc/hosts" "$MNT/etc/mailbox-customer"

# ── sync before unmount ───────────────────────────────────────────────────────
personalize_log "Syncing filesystem"
sync

# ── trap handles unmount ──────────────────────────────────────────────────────
# (trap fires on EXIT — umount + optional rmdir)

# ── summary ───────────────────────────────────────────────────────────────────
echo
echo "✓ NVMe personalized for customer slug: $SLUG"
echo "  Device           : $TARGET_DISK"
echo "  Rootfs partition : $ROOTFS_PART"
echo "  Identity wiped   : SSH host keys, Tailscale state, journals, bash history"
echo "  Identity set     :"
echo "    /etc/hostname            → $SLUG"
echo "    /etc/mailbox-customer    → $SLUG"
if [[ -f "$NVME_ENV_PATH" ]]; then
  echo "    $ENV_REL_PATH_CLEAN → MAILBOX_LAN_HOSTNAME=${SLUG}.local"
else
  echo "    $ENV_REL_PATH_CLEAN → NOT FOUND (set MAILBOX_LAN_HOSTNAME=${SLUG}.local during provisioning)"
fi
echo "    /etc/ssh/regenerate-on-boot → marker created"
echo
echo "Next steps:"
echo "  1. Eject the NVMe: eject $TARGET_DISK (or physically remove)"
echo "  2. Boot-verify on a spare Jetson:"
echo "       hostname                 → should print '$SLUG'"
echo "       cat /etc/mailbox-customer → should print '$SLUG'"
echo "       ls /etc/ssh/ssh_host_*    → keys should exist (regenerated on first boot)"
echo "       tailscale status          → should show a NEW node (not a duplicate of seed)"
echo "  3. Pack into the customer appliance."
echo "  4. See docs/runbook/factory-image-pipeline.v0.1.0.md §4 for full boot-verify checklist."
