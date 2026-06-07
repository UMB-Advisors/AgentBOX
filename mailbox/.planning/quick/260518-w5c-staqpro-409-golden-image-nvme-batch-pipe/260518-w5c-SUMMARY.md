# Quick Task 260518-w5c-01 — STAQPRO-409 Golden Image NVMe Batch Pipeline

## What shipped

Two shell scripts and one operator runbook that collapse per-customer Jetson appliance provisioning from a multi-hour SDK Manager flash session into a ~17-minute `dd` + personalization pipeline. `scripts/factory-image.sh` captures a fully-bootstrapped seed NVMe to a compressed golden master image on the provisioner workstation (run once per JetPack version). `scripts/factory-prep-nvme.sh` mounts a `dd`-restored NVMe, wipes all per-host identity (SSH keys, Tailscale state, journals, histories), and stamps the customer slug into `/etc/hostname`, `/etc/hosts`, and `/etc/mailbox-customer`. Both scripts implement the full project safety-gate pattern (root check, `--dry-run`, `--yes`, root-device refusal, `trap EXIT` cleanup). The runbook at `docs/runbook/factory-image-pipeline.v0.1.0.md` documents the two-phase pipeline end-to-end and cross-references STAQPRO-225 (seed-flash) and STAQPRO-410 (factory-bootstrap.sh).

## Files

| File | Lines | Purpose |
|------|-------|---------|
| `scripts/factory-image.sh` | 299 | Workstation-side golden-image capture from seed NVMe to compressed `.img.zst` |
| `scripts/factory-prep-nvme.sh` | 329 | Per-customer NVMe personalization: slug stamp, identity wipe, trap-guarded umount |
| `docs/runbook/factory-image-pipeline.v0.1.0.md` | 335 | Operator runbook covering Phase A (capture) and Phase B (per-customer flash) |

## Safety guards implemented

| Guard | `factory-image.sh` | `factory-prep-nvme.sh` |
|-------|-------------------|------------------------|
| Must run as root | `[[ $EUID -ne 0 ]]` → exit 1 | Same |
| `--dry-run` | Prints plan, exits 0 before any I/O | Prints plan, exits 0 before any mount |
| `--yes` / interactive `YES` | Required to proceed | Required to proceed |
| Root-device refusal | `lsblk -no PKNAME` + `findmnt -no SOURCE /`; exits 3 if source = workstation root | Same check for target disk; also checks if any partition is mounted as `/` or `/boot` |
| Slug regex (factory-prep) | N/A | `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$` validated before any device operation; exits 2 |
| Free space (factory-image) | Requires 1.1× source size at destination; exits 3 if insufficient | N/A |
| Atomic output (factory-image) | Captures to `.partial`, renames on success; `trap EXIT` deletes `.partial` on kill | N/A |
| Trap-guarded unmount (factory-prep) | N/A | `trap 'sync; umount ... || true; rmdir ... || true' EXIT` — fires on Ctrl-C, OOM kill |

## Commits

| Hash | Message |
|------|---------|
| `3108f7b` | `feat(scripts): add factory-image.sh for golden-image capture (STAQPRO-409)` |
| `6d267bd` | `feat(scripts): add factory-prep-nvme.sh for per-customer NVMe personalization (STAQPRO-409)` |
| `1a73517` | `docs(runbook): add factory-image-pipeline v0.1.0 (STAQPRO-409)` |

## Verification commands run

```
bash -n scripts/factory-image.sh          → OK
bash -n scripts/factory-prep-nvme.sh      → OK
test -x scripts/factory-image.sh          → OK (0755)
test -x scripts/factory-prep-nvme.sh      → OK (0755)
grep -q 'STAQPRO-225' docs/runbook/...    → OK
grep -q 'STAQPRO-410' docs/runbook/...    → OK
git diff --stat origin/master..HEAD        → exactly 3 files, 963 insertions
git log --oneline origin/master..HEAD      → 3 commits, one per task
```

Root check fires before slug/device validation (by design — root is the first gate). Non-root execution exits 1. Slug regex rejects uppercase / special chars / leading-hyphen patterns at exit 2 before any mount.

## Hardware verification steps (Dustin at the bench)

These are the exact commands to run when you have a seed NVMe ready and a blank NVMe for the first batch test:

### Phase A — capture the seed NVMe

```bash
# 1. Insert seed NVMe into workstation M.2 / USB adapter. Identify it:
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT
ls -l /dev/disk/by-id/ | grep nvme

# 2. Dry-run first (replace <seed-id> with the actual by-id value):
sudo ./scripts/factory-image.sh --dry-run \
    --source /dev/disk/by-id/<seed-id> \
    --jetpack-version 6.2 \
    --output-dir /var/lib/mailbox-images

# 3. Confirm the output paths and size look right. Then capture for real:
sudo ./scripts/factory-image.sh \
    --source /dev/disk/by-id/<seed-id> \
    --jetpack-version 6.2 \
    --output-dir /var/lib/mailbox-images
# → type YES at the prompt

# 4. Verify sha256 after capture:
sha256sum --check /var/lib/mailbox-images/mailbox-golden-v6.2-$(date +%Y-%m-%d).img.sha256
```

### Phase B — flash and personalize a blank NVMe

```bash
# 1. Remove seed NVMe. Insert blank NVMe. Identify target:
lsblk -o NAME,SIZE,TYPE,MOUNTPOINT
ls -l /dev/disk/by-id/ | grep nvme

# 2. Decompress golden image:
zstd -d /var/lib/mailbox-images/mailbox-golden-v6.2-$(date +%Y-%m-%d).img.zst \
     -o /tmp/golden.img

# 3. Write to blank NVMe (OPERATOR-TYPED — triple-check target by-id is the blank NVMe):
sudo dd if=/tmp/golden.img \
        of=/dev/disk/by-id/<blank-nvme-id> \
        bs=64M status=progress conv=fsync
sync
rm /tmp/golden.img

# 4. Personalize (dry-run first, then real):
sudo ./scripts/factory-prep-nvme.sh --dry-run \
    --slug test-customer --by-id /dev/disk/by-id/<blank-nvme-id>

sudo ./scripts/factory-prep-nvme.sh \
    --slug test-customer --by-id /dev/disk/by-id/<blank-nvme-id>
# → type YES at the prompt

# 5. Verify filesystem before removing:
sudo mkdir -p /mnt/test-nvme
sudo mount /dev/disk/by-id/<blank-nvme-id>p1 /mnt/test-nvme  # adjust partition
cat /mnt/test-nvme/etc/hostname        # → test-customer
cat /mnt/test-nvme/etc/mailbox-customer  # → test-customer
ls /mnt/test-nvme/etc/ssh/             # → ssh_host_* absent, regenerate-on-boot present
sudo umount /mnt/test-nvme

# 6. Boot on spare bench Jetson — see runbook §4 for boot-verify checklist
```

## Follow-ups and known limitations

1. **Hardware-loop verification at the bench.** All scripts pass syntax checks and dry-run validation, but no real NVMe has been inserted yet. First end-to-end run with real hardware bumps the runbook to v0.2.0. See runbook §4 for the boot-verify checklist.

2. **`/etc/mailbox-customer` not wired into `.env` loader.** The customer slug is stamped as a filesystem artifact but nothing reads it at runtime yet. A separate dashboard change is needed to source `CUSTOMER_SLUG` from `/etc/mailbox-customer` at container start. File a follow-up ticket (was out of scope for STAQPRO-409).

3. **`factory-bootstrap.sh` (STAQPRO-410) not on this branch.** The runbook cross-references it by ticket. Do not modify it on `feat/staqpro-409-golden-image`; coordinate with the STAQPRO-410 owner.

4. **Image storage strategy undefined.** `OPEN Q` in runbook §2.4: where do golden images live long-term? `/var/lib/mailbox-images/` on the provisioner workstation is sufficient for one operator; a shared NAS / S3 becomes relevant at 3+ operators or 5+ customers. Decide before customer #3.

5. **Spare bench Jetson required for §4 boot-verify.** The seed unit is a reference device and should not be used for per-customer boot testing. A second Orin Nano Super is needed for the pipeline to run at pace.
