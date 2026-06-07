// MBOX-184 / MBOX-347 — unit tests for the read-only "Update available"
// detector.
//
// MBOX-347 reworked the source of the "latest published" digest from a
// committed manifest file to a runtime GHCR registry read. These tests inject
// the resolved registry digests (opts.registryDigests) + a pre-resolved
// running-container list (opts.runningContainers), so the suite runs
// identically on macOS dev and the Jetson with no docker daemon and no network
// to ghcr.io — same injection convention as queries-orphans/queries-docker.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __clearRegistryCache,
  checkUpdateAvailability,
  expectedContainerName,
  type RegistryDigestClient,
  shortDigest,
} from '@/lib/queries-update';

const DASH_DIGEST_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DASH_DIGEST_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CADDY_DIGEST = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

/** Build an injected registry-digest map keyed by service. */
function registry(dashDigest: string, caddyDigest: string) {
  return {
    'mailbox-dashboard': { digest: dashDigest },
    'mailbox-caddy': { digest: caddyDigest },
  };
}

afterEach(() => {
  __clearRegistryCache();
});

describe('expectedContainerName — MBOX-184', () => {
  it('uses the explicit container_name override for mailbox-dashboard', () => {
    expect(expectedContainerName('mailbox-dashboard', 'mailbox')).toBe('mailbox-dashboard');
  });

  it('falls back to <project>-<service>-1 for caddy (no override)', () => {
    expect(expectedContainerName('mailbox-caddy', 'mailbox')).toBe('mailbox-caddy-1');
  });

  it('returns null for an unmapped service key', () => {
    expect(expectedContainerName('nope', 'mailbox')).toBeNull();
  });
});

describe('shortDigest', () => {
  it('shortens a sha256 digest to 7 hex chars', () => {
    expect(shortDigest(DASH_DIGEST_A)).toBe('aaaaaaa');
  });
  it('renders an em-dash for null', () => {
    expect(shortDigest(null)).toBe('—');
  });
  it('passes through a non-sha256 string unchanged', () => {
    expect(shortDigest('not-a-digest')).toBe('not-a-digest');
  });
});

describe('checkUpdateAvailability — comparison cases', () => {
  it('reports up_to_date when running digest matches the registry digest', async () => {
    const r = await checkUpdateAvailability({
      registryDigests: registry(DASH_DIGEST_A, CADDY_DIGEST),
      runningContainers: [
        {
          name: 'mailbox-dashboard',
          image: `ghcr.io/umb-advisors/mailbox-dashboard@${DASH_DIGEST_A}`,
        },
        {
          name: 'mailbox-caddy-1',
          image: `ghcr.io/umb-advisors/mailbox-caddy@${CADDY_DIGEST}`,
        },
      ],
    });
    expect(r.reason).toBeNull();
    expect(r.update_available).toBe(false);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('up_to_date');
    expect(dash?.manifest_tag).toBe('latest');
  });

  it('reports update_available when the registry digest differs from running', async () => {
    const r = await checkUpdateAvailability({
      registryDigests: registry(DASH_DIGEST_B, CADDY_DIGEST),
      runningContainers: [
        {
          name: 'mailbox-dashboard',
          image: `ghcr.io/umb-advisors/mailbox-dashboard@${DASH_DIGEST_A}`,
        },
        {
          name: 'mailbox-caddy-1',
          image: `ghcr.io/umb-advisors/mailbox-caddy@${CADDY_DIGEST}`,
        },
      ],
    });
    expect(r.update_available).toBe(true);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('update_available');
    expect(dash?.running_digest).toBe(DASH_DIGEST_A);
    expect(dash?.manifest_digest).toBe(DASH_DIGEST_B);
    expect(dash?.detail).toContain('aaaaaaa');
    expect(dash?.detail).toContain('bbbbbbb');
  });

  it('reports local_build for a tag-only running image (M1 up -d --build path)', async () => {
    const r = await checkUpdateAvailability({
      registryDigests: registry(DASH_DIGEST_A, CADDY_DIGEST),
      runningContainers: [
        {
          name: 'mailbox-dashboard',
          image: 'mailbox-mailbox-dashboard:latest',
        },
        {
          name: 'mailbox-caddy-1',
          image: 'mailbox-caddy:latest',
        },
      ],
    });
    // Local builds must NEVER produce a false "update available".
    expect(r.update_available).toBe(false);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('local_build');
  });

  it('reports no_manifest when the registry has nothing published for the tag', async () => {
    const r = await checkUpdateAvailability({
      registryDigests: {
        'mailbox-dashboard': { error: 'not_published' },
        'mailbox-caddy': { error: 'not_published' },
      },
      runningContainers: [
        {
          name: 'mailbox-dashboard',
          image: 'mailbox-mailbox-dashboard:latest',
        },
      ],
    });
    expect(r.update_available).toBe(false);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('no_manifest');
    expect(dash?.detail).toContain('no published image');
  });

  it('reports no_manifest with the failure reason on a registry read error', async () => {
    const r = await checkUpdateAvailability({
      registryDigests: {
        'mailbox-dashboard': { error: 'ghcr manifest read returned HTTP 503' },
        'mailbox-caddy': { digest: CADDY_DIGEST },
      },
      runningContainers: [
        {
          name: 'mailbox-dashboard',
          image: `ghcr.io/umb-advisors/mailbox-dashboard@${DASH_DIGEST_A}`,
        },
      ],
    });
    // A transient registry failure must NOT assert an update.
    expect(r.update_available).toBe(false);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('no_manifest');
    expect(dash?.detail).toContain('HTTP 503');
  });

  it('reports not_running when the expected container is absent', async () => {
    const r = await checkUpdateAvailability({
      registryDigests: registry(DASH_DIGEST_A, CADDY_DIGEST),
      runningContainers: [],
    });
    expect(r.update_available).toBe(false);
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('not_running');
  });
});

describe('checkUpdateAvailability — degraded paths', () => {
  it('degrades with the docker reason when the socket is unavailable', async () => {
    const r = await checkUpdateAvailability({
      registryDigests: registry(DASH_DIGEST_A, CADDY_DIGEST),
      runningContainers: { unavailable: 'docker socket /var/run/docker.sock not present' },
    });
    expect(r.update_available).toBe(false);
    expect(r.reason).toMatch(/docker socket/);
    expect(r.services).toEqual([]);
  });
});

describe('checkUpdateAvailability — registry client + cache', () => {
  it('resolves digests through an injected registry client (per-service repo + tag)', async () => {
    const calls: Array<{ image: string; tag: string }> = [];
    const client: RegistryDigestClient = async (image, tag) => {
      calls.push({ image, tag });
      return image.endsWith('mailbox-dashboard')
        ? { digest: DASH_DIGEST_A }
        : { digest: CADDY_DIGEST };
    };
    const r = await checkUpdateAvailability({
      registryClient: client,
      noCache: true,
      runningContainers: [
        {
          name: 'mailbox-dashboard',
          image: `ghcr.io/umb-advisors/mailbox-dashboard@${DASH_DIGEST_A}`,
        },
      ],
    });
    expect(calls).toContainEqual({ image: 'umb-advisors/mailbox-dashboard', tag: 'latest' });
    expect(calls).toContainEqual({ image: 'umb-advisors/mailbox-caddy', tag: 'latest' });
    const dash = r.services.find((s) => s.service === 'mailbox-dashboard');
    expect(dash?.state).toBe('up_to_date');
  });

  it('honors a custom namespace + channel tag', async () => {
    const calls: Array<{ image: string; tag: string }> = [];
    const client: RegistryDigestClient = async (image, tag) => {
      calls.push({ image, tag });
      return { digest: DASH_DIGEST_A };
    };
    await checkUpdateAvailability({
      registryClient: client,
      registryNamespace: 'acme',
      channelTag: 'stable',
      noCache: true,
      runningContainers: [],
    });
    expect(calls).toContainEqual({ image: 'acme/mailbox-dashboard', tag: 'stable' });
  });

  it('caches registry reads within the TTL (one call per service across two checks)', async () => {
    const client = vi.fn<RegistryDigestClient>(async () => ({ digest: DASH_DIGEST_A }));
    const opts = {
      registryClient: client as RegistryDigestClient,
      runningContainers: [] as Array<{ name: string; image: string }>,
    };
    await checkUpdateAvailability(opts);
    await checkUpdateAvailability(opts);
    // 2 services × 1 (cached on the 2nd check) = 2 calls, not 4.
    expect(client).toHaveBeenCalledTimes(2);
  });
});
