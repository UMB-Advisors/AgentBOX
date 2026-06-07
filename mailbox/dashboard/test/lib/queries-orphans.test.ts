// MBOX-168 — unit tests for the orphan-container detector.

import { describe, expect, it } from 'vitest';
import { expectedContainerNames, findOrphanContainers } from '@/lib/queries-orphans';

// A minimal fixture mirroring MailBOX's real compose layout: two services
// with explicit container_name, one falling through to the default
// <project>-<svc>-1 pattern.
const COMPOSE_FIXTURE = `
version: '3.8'
services:
  postgres:
    image: postgres:17-alpine
  mailbox-dashboard:
    image: dashboard:latest
    container_name: mailbox-dashboard
  n8n:
    image: n8nio/n8n:2.14.2
`;

describe('expectedContainerNames', () => {
  it('uses container_name when set, otherwise <project>-<svc>-1', () => {
    const compose = {
      services: {
        postgres: { image: 'postgres' },
        'mailbox-dashboard': { container_name: 'mailbox-dashboard' },
        n8n: { image: 'n8nio/n8n:2.14.2' },
      },
    };
    const r = expectedContainerNames(compose, 'mailbox');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.names.sort()).toEqual(['mailbox-dashboard', 'mailbox-n8n-1', 'mailbox-postgres-1']);
  });

  it('flags a compose object with no `services:` block', () => {
    const r = expectedContainerNames({}, 'mailbox');
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected not ok');
    expect(r.reason).toMatch(/no `services:` block/);
  });

  it('flags non-object input', () => {
    expect(expectedContainerNames(null, 'mailbox').ok).toBe(false);
    expect(expectedContainerNames('a string', 'mailbox').ok).toBe(false);
  });

  it('ignores service entries that are not objects', () => {
    const compose = {
      services: {
        good: { image: 'x' },
        bad: null,
      },
    };
    const r = expectedContainerNames(compose, 'mailbox');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('expected ok');
    expect(r.names).toEqual(['mailbox-good-1']);
  });
});

describe('findOrphanContainers — happy path', () => {
  it('returns green when running matches expected exactly', async () => {
    const r = await findOrphanContainers({
      composeYaml: COMPOSE_FIXTURE,
      projectName: 'mailbox',
      runningContainers: ['mailbox-postgres-1', 'mailbox-dashboard', 'mailbox-n8n-1'],
    });
    expect(r.status).toBe('green');
    expect(r.orphan_count).toBe(0);
    expect(r.orphan_names).toEqual([]);
    expect(r.reason).toBeNull();
    expect(r.expected_names).toEqual(['mailbox-dashboard', 'mailbox-n8n-1', 'mailbox-postgres-1']);
  });

  it('flags a single orphan with its name and an operator-facing reason', async () => {
    const r = await findOrphanContainers({
      composeYaml: COMPOSE_FIXTURE,
      projectName: 'mailbox',
      runningContainers: [
        'mailbox-postgres-1',
        'mailbox-dashboard',
        'mailbox-n8n-1',
        'ghost-llama-cpp', // not in compose
      ],
    });
    expect(r.status).toBe('red');
    expect(r.orphan_count).toBe(1);
    expect(r.orphan_names).toEqual(['ghost-llama-cpp']);
    expect(r.reason).toMatch(/1 orphan container running/);
    expect(r.reason).toMatch(/ghost-llama-cpp/);
    expect(r.reason).toMatch(/DR-25/);
  });

  it('flags multiple orphans with stable sort order', async () => {
    const r = await findOrphanContainers({
      composeYaml: COMPOSE_FIXTURE,
      projectName: 'mailbox',
      runningContainers: [
        'mailbox-postgres-1',
        'zzz-orphan',
        'aaa-orphan',
        'mailbox-dashboard',
        'mailbox-n8n-1',
      ],
    });
    expect(r.status).toBe('red');
    expect(r.orphan_count).toBe(2);
    expect(r.orphan_names).toEqual(['aaa-orphan', 'zzz-orphan']);
    expect(r.reason).toMatch(/2 orphan containers/);
  });

  it('does NOT flag expected names that are not running (separate problem class)', async () => {
    // n8n is expected but missing from the running list. That's a service-
    // down problem, NOT an orphan. Status must stay green.
    const r = await findOrphanContainers({
      composeYaml: COMPOSE_FIXTURE,
      projectName: 'mailbox',
      runningContainers: ['mailbox-postgres-1', 'mailbox-dashboard'],
    });
    expect(r.status).toBe('green');
    expect(r.orphan_count).toBe(0);
  });
});

describe('findOrphanContainers — degraded paths', () => {
  it('returns red with a parse-error reason when compose YAML is malformed', async () => {
    const r = await findOrphanContainers({
      composeYaml: 'services:\n  bad: [unclosed',
      runningContainers: [],
    });
    expect(r.status).toBe('red');
    expect(r.reason).toMatch(/parse failed/);
  });

  it('returns red when compose has no services block', async () => {
    const r = await findOrphanContainers({
      composeYaml: 'version: "3.8"\nvolumes:\n  data: {}',
      runningContainers: [],
    });
    expect(r.status).toBe('red');
    expect(r.reason).toMatch(/no `services:` block/);
  });

  it('returns red when the docker socket is unreachable, preserving expected_names', async () => {
    const r = await findOrphanContainers({
      composeYaml: COMPOSE_FIXTURE,
      projectName: 'mailbox',
      runningContainers: {
        unavailable: 'docker socket /var/run/docker.sock not present in dashboard container',
      },
    });
    expect(r.status).toBe('red');
    expect(r.reason).toMatch(/socket .* not present/);
    expect(r.expected_names).toEqual(['mailbox-dashboard', 'mailbox-n8n-1', 'mailbox-postgres-1']);
  });

  it('honours an alternate compose project name', async () => {
    const r = await findOrphanContainers({
      composeYaml: 'services:\n  api:\n    image: x\n',
      projectName: 'thumbox',
      runningContainers: ['thumbox-api-1'],
    });
    expect(r.status).toBe('green');
    expect(r.expected_names).toEqual(['thumbox-api-1']);
  });
});
