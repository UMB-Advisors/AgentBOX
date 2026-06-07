#!/usr/bin/env bash
# factory-image.sh — capture a seed NVMe to a compressed golden-master image
#
# PURPOSE: Capture a seed NVMe (already factory-bootstrapped per STAQPRO-410's
# factory-bootstrap.sh) to a compressed golden-master image on the workstation.
# Runs ONCE per JetPack version on Dustin's workstation. The captured image is
# later dd'd onto blank NVMes at packing time and personalized per-customer via
# scripts/factory-prep-nvme.sh. STAQPRO-409.
#
# ──────────────────────────────────────────────────────────────────────────────
# USAGE
#   ./scripts/factory-image.sh [--dry-run] [--yes] [--no-compress] \
#       [--output-dir <dir>] [--jetpack-version <ver>] --source <device-or-by-id>
#
#   --source       /dev/nvmeXn1 or /dev/disk/by-id/<id>
#                  Prefer /dev/disk/by-id/ — names are stable across reboots.
#   --jetpack-version  JetPack version string for the output filename (e.g. 6.2).
#                      Defaults to reading from /etc/nv_tegra_release when run
#                      on a Jetson; REQUIRED when run on a non-Jetson workstation.
#   --output-dir   Destination directory (default: /var/lib/mailbox-images).
#                  Created with 0755 permissions if it does not exist.
#   --no-compress  Skip zstd compression. Produces .img + .img.sha256 only.
#   --dry-run      Print planned action and exit 0 — no reads, no writes.
#   --yes          Skip the interactive confirmation prompt (require literal YES).
#
# EXAMPLES
#   # Dry-run — identify the device first, then preview
#   ls -l /dev/disk/by-id/ | grep nvme
#   sudo ./scripts/factory-image.sh --dry-run \
#       --source /dev/disk/by-id/nvme-SPCC_M.2_PCIe_SSD_AB12345678 \
#       --jetpack-version 6.2 --output-dir /var/lib/mailbox-images
#
#   # Real capture (operator types YES at the prompt)
#   sudo ./scripts/factory-image.sh \
#       --source /dev/disk/by-id/nvme-SPCC_M.2_PCIe_SSD_AB12345678 \
#       --jetpack-version 6.2 --output-dir /var/lib/mailbox-images
#
#   # Non-interactive (CI / scripted provisioning)
#   sudo ./scripts/factory-image.sh --yes --no-compress \
#       --source /dev/nvme1n1 --jetpack-version 6.2
#
# REQUIRED ENV / PRE-CONDITIONS
#   - Must run as root (sudo)
#   - lsblk, findmnt, blockdev available (coreutils + util-linux, present on Ubuntu 22.04)
#   - pv optional (progress display) — falls back to dd status=progress if absent
#   - zstd optional (compression) — skipped with a warning if absent and --no-compress not set
#
# EXIT CODES
#   0  success
#   1  bad invocation / missing root
#   2  validation failure (source missing, jetpack version unknown, output dir failed)
#   3  safety gate tripped (root-device match, insufficient free space, user declined)
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

PROG="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── defaults ─────────────────────────────────────────────────────────────────
DRY_RUN=0
YES=0
NO_COMPRESS=0
OUTPUT_DIR="/var/lib/mailbox-images"
SOURCE=""
JETPACK_VERSION=""
OUT_IMG=""          # set after validation
OUT_IMG_PARTIAL=""  # temp path during capture

usage() {
  sed -n '/^# USAGE/,/^# EXAMPLES/{ /^# EXAMPLES/d; s/^# \{0,1\}//; p }' "$0"
}

# ── arg parsing ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)          DRY_RUN=1; shift ;;
    --yes)              YES=1; shift ;;
    --no-compress)      NO_COMPRESS=1; shift ;;
    --output-dir)       OUTPUT_DIR="${2:?--output-dir requires a path}"; shift 2 ;;
    --source)           SOURCE="${2:?--source requires a device path}"; shift 2 ;;
    --jetpack-version)  JETPACK_VERSION="${2:?--jetpack-version requires a value}"; shift 2 ;;
    -h|--help)          usage; exit 0 ;;
    -*)                 echo "$PROG: unknown flag: $1" >&2; usage >&2; exit 1 ;;
    *)                  echo "$PROG: unexpected argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# ── root check ────────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  echo "ERROR: $PROG must run as root (use sudo)." >&2
  exit 1
fi

# ── --source required ─────────────────────────────────────────────────────────
if [[ -z "$SOURCE" ]]; then
  echo "ERROR: --source is required." >&2
  usage >&2
  exit 1
fi

# ── resolve by-id symlinks to a canonical /dev/... path ──────────────────────
SOURCE_RESOLVED="$(readlink -f "$SOURCE")"

# ── validate source is a block device ────────────────────────────────────────
if [[ ! -b "$SOURCE_RESOLVED" ]]; then
  echo "ERROR: --source '$SOURCE' (resolved: '$SOURCE_RESOLVED') is not a block device." >&2
  echo "       Run 'lsblk' and 'ls -l /dev/disk/by-id/ | grep nvme' to identify the NVMe." >&2
  exit 2
fi

# ── safety gate: refuse if source is workstation root device ─────────────────
ROOT_SRC="$(findmnt -no SOURCE /)"
ROOT_PARENT_NAME="$(lsblk -no PKNAME "$ROOT_SRC" 2>/dev/null | head -1 || true)"
if [[ -z "$ROOT_PARENT_NAME" ]]; then
  # findmnt SOURCE is already the whole disk (e.g., /dev/sda) — use it directly
  ROOT_DISK="$ROOT_SRC"
else
  ROOT_DISK="/dev/${ROOT_PARENT_NAME}"
fi

# Determine source parent disk
SOURCE_PARENT_NAME="$(lsblk -no PKNAME "$SOURCE_RESOLVED" 2>/dev/null | head -1 || true)"
if [[ -z "$SOURCE_PARENT_NAME" ]]; then
  SOURCE_DISK="$SOURCE_RESOLVED"
else
  SOURCE_DISK="/dev/${SOURCE_PARENT_NAME}"
fi

ROOT_DISK_RESOLVED="$(readlink -f "$ROOT_DISK" || echo "$ROOT_DISK")"
SOURCE_DISK_RESOLVED="$(readlink -f "$SOURCE_DISK" || echo "$SOURCE_DISK")"

if [[ "$SOURCE_DISK_RESOLVED" == "$ROOT_DISK_RESOLVED" ]]; then
  echo "REFUSED: --source resolves to the workstation's root device $ROOT_DISK_RESOLVED" >&2
  echo "         The source device and the workstation's root device are the same." >&2
  echo "         Re-verify with 'lsblk' — ensure the seed NVMe is the target, not the system disk." >&2
  exit 3
fi

# ── JetPack version: auto-detect or require ──────────────────────────────────
if [[ -z "$JETPACK_VERSION" ]]; then
  if [[ -f /etc/nv_tegra_release ]]; then
    # Extract version like "6.2" from "R36 REVISION: 4.0" → "36.4" → map to JetPack "6.2"
    # We use the R-level + revision directly as a version string (e.g., "r36.4")
    R_LEVEL="$(grep -oP 'R\d+' /etc/nv_tegra_release | head -1 | tr -d 'R' || true)"
    REVISION="$(grep -i 'REVISION' /etc/nv_tegra_release | grep -oP '\d+\.\d+' | head -1 || true)"
    if [[ -n "$R_LEVEL" && -n "$REVISION" ]]; then
      JETPACK_VERSION="r${R_LEVEL}.${REVISION}"
    fi
  fi
  if [[ -z "$JETPACK_VERSION" ]]; then
    echo "ERROR: --jetpack-version is required when not running on a Jetson" >&2
    echo "       (could not read /etc/nv_tegra_release)." >&2
    echo "       Example: --jetpack-version 6.2" >&2
    exit 2
  fi
fi

# ── output directory ──────────────────────────────────────────────────────────
if [[ ! -d "$OUTPUT_DIR" ]]; then
  if ! install -d -m 0755 "$OUTPUT_DIR"; then
    echo "ERROR: could not create output directory '$OUTPUT_DIR'." >&2
    exit 2
  fi
fi

# ── build output filenames ────────────────────────────────────────────────────
TODAY="$(date +%Y-%m-%d)"
IMG_BASENAME="mailbox-golden-v${JETPACK_VERSION}-${TODAY}"
OUT_IMG="${OUTPUT_DIR}/${IMG_BASENAME}.img"
OUT_IMG_PARTIAL="${OUTPUT_DIR}/${IMG_BASENAME}.img.partial"
OUT_SHA="${OUT_IMG}.sha256"
OUT_ZST="${OUT_IMG}.zst"
OUT_ZST_SHA="${OUT_ZST}.sha256"

# ── source device info ────────────────────────────────────────────────────────
SOURCE_SIZE_BYTES="$(blockdev --getsize64 "$SOURCE_RESOLVED")"
SOURCE_SIZE_HUMAN="$(numfmt --to=si --suffix=B "$SOURCE_SIZE_BYTES" 2>/dev/null || echo "${SOURCE_SIZE_BYTES} bytes")"

# ── free space check ─────────────────────────────────────────────────────────
FREE_BYTES="$(df -B1 --output=avail "$OUTPUT_DIR" | tail -1 | tr -d ' ')"
# Require 1.1 × source size (headroom for partial + sha256)
REQUIRED_BYTES="$(awk "BEGIN { printf \"%d\", $SOURCE_SIZE_BYTES * 1.1 }")"

if (( FREE_BYTES < REQUIRED_BYTES )); then
  FREE_HUMAN="$(numfmt --to=si --suffix=B "$FREE_BYTES" 2>/dev/null || echo "${FREE_BYTES} bytes")"
  REQ_HUMAN="$(numfmt --to=si --suffix=B "$REQUIRED_BYTES" 2>/dev/null || echo "${REQUIRED_BYTES} bytes")"
  echo "REFUSED: insufficient free space at '$OUTPUT_DIR'." >&2
  echo "         Available: ${FREE_HUMAN}   Required: ${REQ_HUMAN} (1.1 × source size)" >&2
  echo "         Free up space or choose a different --output-dir." >&2
  exit 3
fi

# ── print planned action ──────────────────────────────────────────────────────
echo "→ factory-image.sh — golden image capture plan"
echo "  Source (arg)       : $SOURCE"
echo "  Source (resolved)  : $SOURCE_RESOLVED"
echo "  Source size        : $SOURCE_SIZE_HUMAN"
echo "  Output image       : $OUT_IMG"
if [[ $NO_COMPRESS -eq 0 ]]; then
  echo "  Compressed output  : $OUT_ZST"
fi
echo "  Free space         : $(numfmt --to=si --suffix=B "$FREE_BYTES" 2>/dev/null || echo "${FREE_BYTES} bytes")"
echo "  JetPack version    : $JETPACK_VERSION"
if [[ $DRY_RUN -eq 1 ]]; then
  echo "  Mode               : DRY RUN — no reads or writes"
fi

# ── dry-run short-circuit ─────────────────────────────────────────────────────
if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "Dry run complete. No data read. Rerun without --dry-run to capture."
  exit 0
fi

# ── confirmation ──────────────────────────────────────────────────────────────
echo
echo "WARNING: This will READ the entire device '$SOURCE_RESOLVED' ($SOURCE_SIZE_HUMAN)."
echo "         The capture is non-destructive (read-only on the source)."
echo "         Output will be written to: $OUT_IMG"
echo

if [[ $YES -ne 1 ]]; then
  read -r -p "Type 'YES' to proceed: " confirm
  if [[ "$confirm" != "YES" ]]; then
    echo "Aborted by user."
    exit 3
  fi
fi

# ── trap: remove partial file on exit ────────────────────────────────────────
# Capture to .partial first; mv to final name only on success.
trap 'rm -f "$OUT_IMG_PARTIAL"' EXIT

# ── capture ───────────────────────────────────────────────────────────────────
echo
echo "→ Capturing $SOURCE_RESOLVED → $OUT_IMG_PARTIAL …"
START_EPOCH=$(date +%s)

if command -v pv >/dev/null 2>&1; then
  pv -tpreb "$SOURCE_RESOLVED" | dd of="$OUT_IMG_PARTIAL" bs=64M conv=fsync iflag=fullblock
else
  dd if="$SOURCE_RESOLVED" of="$OUT_IMG_PARTIAL" bs=64M status=progress conv=fsync iflag=fullblock
fi

END_EPOCH=$(date +%s)
DURATION=$(( END_EPOCH - START_EPOCH ))

# Promote partial to final name on success
mv "$OUT_IMG_PARTIAL" "$OUT_IMG"
# Clear partial trap (file is now renamed)
trap - EXIT

echo "→ Capture complete in ${DURATION}s."

# ── sha256 of raw image ───────────────────────────────────────────────────────
echo "→ Computing sha256 of $OUT_IMG …"
sha256sum "$OUT_IMG" > "$OUT_SHA"
echo "  $(cat "$OUT_SHA")"

# ── optional compression ──────────────────────────────────────────────────────
if [[ $NO_COMPRESS -eq 0 ]]; then
  if command -v zstd >/dev/null 2>&1; then
    echo "→ Compressing with zstd -19 (this takes several minutes) …"
    zstd -19 --rm "$OUT_IMG" -o "$OUT_ZST"
    sha256sum "$OUT_ZST" > "$OUT_ZST_SHA"
    echo "  Compressed: $OUT_ZST"
    echo "  sha256:     $(cat "$OUT_ZST_SHA")"
  else
    echo "WARN: zstd not installed — skipping compression. Image is still usable."
    echo "      Install: sudo apt-get install zstd"
  fi
fi

# ── summary ───────────────────────────────────────────────────────────────────
echo
echo "✓ Golden image captured."
echo "  Image     : $OUT_IMG"
if [[ $NO_COMPRESS -eq 0 && -f "$OUT_ZST" ]]; then
  echo "  Compressed: $OUT_ZST"
fi
echo "  sha256    : $(cat "$OUT_SHA")"
echo "  Duration  : ${DURATION}s"
echo
echo "Next steps:"
echo "  1. Insert a blank NVMe into a USB-NVMe adapter or workstation M.2 slot."
echo "  2. Identify the target device: lsblk && ls -l /dev/disk/by-id/ | grep nvme"
echo "  3. Write the image (operator types this command — see runbook §3):"
if [[ -f "$OUT_ZST" ]]; then
  echo "       zstd -d $OUT_ZST -o /tmp/golden.img"
  echo "       sudo dd if=/tmp/golden.img of=/dev/disk/by-id/<target-by-id> bs=64M status=progress conv=fsync"
else
  echo "       sudo dd if=$OUT_IMG of=/dev/disk/by-id/<target-by-id> bs=64M status=progress conv=fsync"
fi
echo "       sync"
echo "  4. Personalize: sudo ./scripts/factory-prep-nvme.sh --slug <customer-slug> --by-id /dev/disk/by-id/<target>"
echo "  5. Boot-verify on a spare Jetson before packing."
echo
echo "See: docs/runbook/factory-image-pipeline.v0.1.0.md"
