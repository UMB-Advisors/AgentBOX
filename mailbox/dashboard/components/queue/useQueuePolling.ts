// STAQPRO-331 #11 / MBOX-360 — visibility-aware polling + account-filter
// refetch. Extracted verbatim from QueueClient.tsx.

import { useCallback, useEffect, useRef } from 'react';
import type { CooldownState } from '@/components/GmailCooldownBanner';
import { apiUrl } from '@/lib/api';
import type { DraftWithMessage } from '@/lib/types';
import { POLL_INTERVAL_MS } from './constants';
import type { FolderKey, Mode } from './utils';

interface UseQueuePollingParams {
  folder: FolderKey;
  mode: Mode;
  statusQuery: string;
  urgentParam: string;
  accountParam: string;
  accountFilter: number | undefined;
  wantsStuck: boolean;
  initialList: DraftWithMessage[];
  setDrafts: (list: DraftWithMessage[]) => void;
  setStuckApproved: (list: DraftWithMessage[]) => void;
  setCooldown: (state: CooldownState) => void;
  setNewCount: (updater: (c: number) => number) => void;
}

export function useQueuePolling({
  mode,
  statusQuery,
  urgentParam,
  accountParam,
  accountFilter,
  wantsStuck,
  initialList,
  setDrafts,
  setStuckApproved,
  setCooldown,
  setNewCount,
}: UseQueuePollingParams) {
  const knownIds = useRef<Set<number>>(new Set(initialList.map((d) => d.id)));

  const fetchData = useCallback(
    async (silent: boolean) => {
      try {
        const [listRes, stuckRes, cooldownRes] = await Promise.all([
          fetch(apiUrl(`/api/drafts?status=${statusQuery}&limit=50${urgentParam}${accountParam}`), {
            cache: 'no-store',
          }),
          // Stuck-approved banner only needs refreshing on the queue folder;
          // skip the round trip otherwise.
          wantsStuck
            ? fetch(apiUrl('/api/drafts?status=approved&limit=50'), { cache: 'no-store' })
            : Promise.resolve(null),
          // STAQPRO-331 #5 — Gmail cooldown refresh. Don't gate the whole
          // fetchData on it; if the cooldown route errors, drafts still
          // update. Cooldown is best-effort UI signal.
          fetch(apiUrl('/api/system/gmail-cooldown'), { cache: 'no-store' }),
        ]);
        if (!listRes.ok) return;
        const listJson = await listRes.json();
        const nextList: DraftWithMessage[] = listJson.drafts ?? [];

        if (silent) {
          for (const d of nextList) knownIds.current.add(d.id);
        } else if (mode === 'active') {
          const fresh = nextList.map((d) => d.id).filter((id) => !knownIds.current.has(id));
          if (fresh.length > 0) {
            setNewCount((c) => c + fresh.length);
            for (const id of fresh) knownIds.current.add(id);
          }
        }

        setDrafts(nextList);

        if (wantsStuck && stuckRes?.ok) {
          const stuckJson = await stuckRes.json();
          setStuckApproved(stuckJson.drafts ?? []);
        }

        if (cooldownRes.ok) {
          const cooldownJson = (await cooldownRes.json()) as CooldownState;
          setCooldown(cooldownJson);
        }
      } catch {
        // Background poll — swallow transient errors.
      }
    },
    [
      statusQuery,
      urgentParam,
      accountParam,
      wantsStuck,
      mode,
      setDrafts,
      setStuckApproved,
      setCooldown,
      setNewCount,
    ],
  );

  // STAQPRO-331 #11 — visibility-aware polling. Skip ticks when the tab is
  // hidden (no point spending battery + n8n CPU when nobody is watching) and
  // fire an immediate refetch on visibility return so an operator coming
  // back from another tab sees the queue caught up without waiting for the
  // next 30s tick. AbortController per-fetch is intentionally deferred —
  // fetchData uses two parallel cache:'no-store' fetches without
  // cancellation, and the last-write-wins setActive/setSent pattern is
  // already idempotent under in-flight overlap.
  useEffect(() => {
    function tick() {
      if (document.visibilityState !== 'visible') return;
      fetchData(false);
    }
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    function onVisibility() {
      if (document.visibilityState === 'visible') fetchData(false);
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchData]);

  // MBOX-360 (MBOX-162 V3) — refetch immediately when the account filter
  // changes. The polling effect above only re-arms its interval on a fetchData
  // change; it doesn't fire a tick. Silent so switching inboxes doesn't trip
  // the "new drafts" banner. Skip the initial mount — the SSR list already
  // reflects initialAccountId.
  const accountFilterMounted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchData is recreated when accountFilter changes; accountFilter is the intended sole trigger.
  useEffect(() => {
    if (!accountFilterMounted.current) {
      accountFilterMounted.current = true;
      return;
    }
    fetchData(true);
  }, [accountFilter]);

  return { fetchData };
}
