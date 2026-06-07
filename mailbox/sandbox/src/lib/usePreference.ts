// MBOX-133 deliverable #3 — usePreference() hook.
//
// Persists an operator preference (filter chips, sort key, ...) through the
// dashboard's GET/PUT /api/operator/preferences/[key] routes, with a
// localStorage fallback for offline / pre-auth load. Read order on mount:
//
//   1. seed synchronously from localStorage (so the first paint is correct
//      even before any network round-trip),
//   2. then fetch the server row; if it exists, it wins and is mirrored back
//      into localStorage; a 404 (nothing persisted yet) or a network error
//      (the sandbox runs in isolation — no traffic to M1/M2) leaves the
//      localStorage seed in place.
//
// Writes go to both the server (fire-and-forget PUT) and localStorage on every
// setValue, so the sandbox stays fully functional with the routes unreachable.
//
// `T` must be JSON-serializable (object or array). Callers holding non-JSON
// state (e.g. the filter `Set`s in App.tsx) project to/from a serializable
// shape at the call site.

import { useCallback, useEffect, useRef, useState } from 'react'

const LS_PREFIX = 'mailbox-pref-'
const API_BASE = '/api/operator/preferences'

function lsKey(key: string): string {
  return `${LS_PREFIX}${key}`
}

function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(lsKey(key))
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function writeLocal<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(lsKey(key), JSON.stringify(value))
  } catch {
    /* localStorage unavailable; ignore */
  }
}

export interface UsePreferenceResult<T> {
  value: T
  setValue: (next: T) => void
  /** True until the initial server read settles (succeeds, 404s, or errors). */
  loading: boolean
}

export function usePreference<T>(key: string, defaultValue: T): UsePreferenceResult<T> {
  // Synchronous localStorage seed so first paint matches the last session.
  const [value, setValueState] = useState<T>(() => readLocal(key, defaultValue))
  const [loading, setLoading] = useState(true)
  // Guard against a slow server read clobbering a user edit that landed first.
  const dirtyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${API_BASE}/${encodeURIComponent(key)}`, {
          headers: { Accept: 'application/json' },
        })
        if (cancelled || dirtyRef.current) return
        if (res.ok) {
          const body = (await res.json()) as { value: T }
          if (!cancelled && !dirtyRef.current && body && 'value' in body) {
            setValueState(body.value)
            writeLocal(key, body.value)
          }
        }
        // 404 = nothing persisted yet; keep the localStorage seed.
      } catch {
        // Sandbox isolation / offline — localStorage seed stands.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // key is stable per-hook-instance; intentionally not re-running on value.
  }, [key])

  const setValue = useCallback(
    (next: T) => {
      dirtyRef.current = true
      setValueState(next)
      writeLocal(key, next)
      // Fire-and-forget server write; failures fall back to localStorage.
      void fetch(`${API_BASE}/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: next }),
      }).catch(() => {
        /* sandbox isolation / offline — ignore */
      })
    },
    [key],
  )

  return { value, setValue, loading }
}
