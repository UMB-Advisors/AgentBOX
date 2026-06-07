import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Inbox,
  Send,
  Check,
  X,
  Pencil,
  Star,
  Search,
  Menu,
  RefreshCw,
  MoreVertical,
  Archive,
  Sparkles,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Wand2,
  Loader2,
  Calendar,
  Settings,
  ExternalLink,
  CalendarPlus,
  PanelRight,
  PanelRightClose,
  FolderOpen,
  SlidersHorizontal,
  BarChart3,
  BookOpen,
  FileText,
  History,
} from 'lucide-react'
import clsx from 'clsx'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { drafts as fixtureDrafts, type DraftRow, type DraftStatus } from './fixtures/drafts'
import { TuningPage } from './Tuning'
import {
  ALL_CATEGORIES,
  isUrgentUntouched,
  rowDerived,
  type AgeBand,
  type ConfidenceBand,
  type Route,
} from './lib/urgency'
import { FilterBar, EMPTY_FILTERS, filtersActive, type FilterState, type FilterCounts } from './components/FilterBar'
import { SortControls, type SortKey } from './components/SortControls'
import { usePreference } from './lib/usePreference'
import { UrgencyBadge } from './components/UrgencyBadge'
import { RedFlagHeader } from './components/RedFlagHeader'
import { ClassificationOverride } from './components/ClassificationOverride'
import { DigestPreview } from './DigestPreview'
import { KnowledgeBasePage } from './KnowledgeBasePage'
import { InsightsPage } from './InsightsPage'
import { VipManagementPage, type VipMap, type VipEntry } from './VipManagementPage'
import { SearchResultsPage } from './SearchResultsPage'
import { AuditPage } from './AuditPage'

type FolderKey = 'pending' | 'approved' | 'sent' | 'rejected' | 'all'

const FOLDERS: { key: FolderKey; label: string; icon: typeof Inbox }[] = [
  { key: 'pending', label: 'Queue', icon: Inbox },
  { key: 'approved', label: 'Approved', icon: Check },
  { key: 'sent', label: 'Sent', icon: Send },
  { key: 'rejected', label: 'Rejected', icon: X },
  { key: 'all', label: 'All', icon: Archive },
]

const CATEGORY_COLORS: Record<string, string> = {
  escalate: 'bg-red-100 text-red-700 ring-red-200',
  reorder: 'bg-blue-100 text-blue-700 ring-blue-200',
  inquiry: 'bg-emerald-100 text-emerald-700 ring-emerald-200',
  scheduling: 'bg-amber-100 text-amber-800 ring-amber-200',
  follow_up: 'bg-violet-100 text-violet-700 ring-violet-200',
  internal: 'bg-slate-100 text-slate-700 ring-slate-200',
  spam_marketing: 'bg-zinc-100 text-zinc-600 ring-zinc-200',
  unknown: 'bg-zinc-100 text-zinc-600 ring-zinc-200',
}

const STATUS_COLORS: Record<DraftStatus, string> = {
  pending: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  approved: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  sent: 'bg-zinc-100 text-zinc-600 ring-zinc-200',
  rejected: 'bg-rose-50 text-rose-700 ring-rose-200',
}

// Rejection reasons feed the learning loop. Sandbox = capture-only (console).
// Production: POST { draft_id, reason_code, free_text, rejected_at } to
// /api/drafts/:id/reject → writes mailbox.draft_feedback. Downstream signals:
//   wrong_tone           → persona resolver (tone / sign-off / formality)
//   factually_inaccurate → RAG retrieval gap or cloud-route escalation
//   missing_context      → RAG_RETRIEVE_TOP_K / sender-filter recall
//   should_reply_myself  → reclassify category to 'escalate' over time
//   dont_reply           → classifier miss (should have been spam_marketing)
type RejectReasonCode =
  | 'wrong_tone'
  | 'factually_inaccurate'
  | 'missing_context'
  | 'should_reply_myself'
  | 'dont_reply'
  | 'other'

const REJECT_REASONS: { code: RejectReasonCode; label: string; hint: string }[] = [
  { code: 'wrong_tone', label: 'Wrong tone / not my voice', hint: 'persona — tone, formality, sign-off' },
  { code: 'factually_inaccurate', label: 'Factually inaccurate', hint: 'hallucinated detail or commitment' },
  { code: 'missing_context', label: 'Missing context', hint: 'should have known from prior threads' },
  { code: 'should_reply_myself', label: 'I should reply myself', hint: 'escalate — not draftable by model' },
  { code: 'dont_reply', label: "Don't reply at all", hint: 'spam / no-action — classifier miss' },
  { code: 'other', label: 'Other (please specify)', hint: '' },
]

function senderName(addr: string): string {
  if (!addr) return '(unknown)'
  const local = addr.split('@')[0]
  return local
    .split(/[._-]/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() + p.slice(1))
    .join(' ')
}

function senderInitial(addr: string): string {
  if (!addr) return '?'
  return addr[0].toUpperCase()
}

function senderColor(addr: string): string {
  const palette = ['bg-rose-500', 'bg-amber-500', 'bg-emerald-500', 'bg-blue-500', 'bg-violet-500', 'bg-pink-500', 'bg-teal-500', 'bg-orange-500']
  let h = 0
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

function snippetFromDraft(d: DraftRow): string {
  const text = (d.draft_body || '').replace(/\s+/g, ' ').trim()
  return text.slice(0, 180)
}

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

// Defensive cleanup on model output. qwen2.5 generally doesn't add preamble,
// but occasionally emits "Sure, here's the rewritten email:" or wraps in
// --- delimiters. Strip any obvious wrappers + leading/trailing markers.
function cleanModelOutput(text: string): string {
  let t = text
    // Strip qwen3-style thinking wrappers (defensive — sandbox uses qwen2.5)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    // Strip leading "Sure, here's...", "Here is the...", etc.
    .replace(/^(Sure[!,. ]+(?:here['']?s|here is)[^.\n]*[:.]?\s*)/i, '')
    .replace(/^(Here['']?s the[^.\n]*[:.]?\s*)/i, '')
    .replace(/^(Below is[^.\n]*[:.]?\s*)/i, '')
  // Strip surrounding --- fences
  t = t.replace(/^\s*-{3,}\s*\n/, '').replace(/\n\s*-{2,}\s*$/, '')
  return t.trim()
}

// Real redraft via the Vite proxy at /ollama.
// Sandbox uses qwen2.5:3b instead of the appliance's qwen3:4b-ctx4k because
// qwen3 is a thinking-mode model and won't suppress its reasoning even with
// `/no_think` + `think:false` — every redraft would burn 20-30s producing
// chain-of-thought before the actual email. qwen2.5:3b is the same family,
// no thinking mode, ~0.5-2s redraft latency, and follows tone instructions
// well enough for design exploration. Production would still use qwen3:4b
// via the existing dashboard /api/internal/draft-prompt route.
async function callRedraft(
  inboundBody: string,
  currentDraft: string,
  history: ChatMsg[],
  newPrompt: string,
  signal: AbortSignal,
  appointmentUrl: string,
): Promise<string> {
  const systemPrompt = [
    'You rewrite email drafts for a small business operator.',
    'Output rules:',
    '- Reply with the rewritten email body and nothing else.',
    '- No preamble. Do not say "Sure", "Here is", "Here\'s", "Below is", etc.',
    '- Do not wrap the email in --- delimiters or quotes.',
    '- Begin with the first word of the email itself (greeting line).',
    '- Match the requested tone precisely; if asked for "annoyed", make it sound annoyed.',
    '- Sign off "— Heron Labs" unless told otherwise.',
    // Operator-set scheduling link. Conditional so we never inject a fabricated
    // URL when the operator hasn't configured one.
    ...(appointmentUrl.trim()
      ? [
          `- If the customer is asking to schedule a meeting, share this booking link verbatim: ${appointmentUrl.trim()}`,
        ]
      : []),
  ].join('\n')

  const userTurn = [
    'Inbound message we are replying to:',
    inboundBody || '(no inbound body)',
    '',
    'Current draft:',
    currentDraft,
    '',
    `Redraft instruction: ${newPrompt}`,
  ].join('\n')

  const messages = [
    { role: 'system', content: systemPrompt },
    // Prior turns so iterative refinement works
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userTurn },
  ]

  const res = await fetch('/ollama/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen2.5:3b',
      messages,
      stream: false,
      think: false, // STAQPRO-240 — works on Ollama 0.23+; harmless on older runtimes
      options: { temperature: 0.5, num_predict: 1500 },
    }),
    signal,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Ollama returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const json = (await res.json()) as { message?: { content?: string } }
  const raw = json.message?.content ?? ''
  return cleanModelOutput(raw)
}

// localStorage key for the operator's settings — sandbox-only persistence.
// Production would store this in mailbox.persona.statistical_markers.appointment_url.
const SETTINGS_STORAGE_KEY = 'mailbox-sandbox-settings-v1'

// MBOX-133 — preference keys for the durable filter/sort state. These match the
// dotted-namespace shape the GET/PUT /api/operator/preferences/[key] routes
// accept (lowercase segments, see PREFERENCE_KEY_RE in the dashboard).
const PREF_QUEUE_FILTERS = 'queue.filters'
const PREF_QUEUE_SORT = 'queue.sort'

// FilterState holds Sets, which don't JSON-serialize. Project to/from a plain
// string-array shape for persistence; the deserialize casts string arrays back
// to the typed Sets (the chip components only ever feed in valid values).
interface SerializedFilters {
  categories: string[]
  statuses: string[]
  routes: string[]
  confidence_bands: string[]
  age_bands: string[]
}

function serializeFilters(f: FilterState): SerializedFilters {
  return {
    categories: [...f.categories],
    statuses: [...f.statuses],
    routes: [...f.routes],
    confidence_bands: [...f.confidence_bands],
    age_bands: [...f.age_bands],
  }
}

function deserializeFilters(s: SerializedFilters): FilterState {
  return {
    categories: new Set(s.categories ?? []),
    statuses: new Set((s.statuses ?? []) as DraftStatus[]),
    routes: new Set((s.routes ?? []) as Route[]),
    confidence_bands: new Set((s.confidence_bands ?? []) as ConfidenceBand[]),
    age_bands: new Set((s.age_bands ?? []) as AgeBand[]),
  }
}

const EMPTY_SERIALIZED_FILTERS: SerializedFilters = serializeFilters(EMPTY_FILTERS)

type RightPaneTab = 'calendar' | 'drive'

interface OperatorSettings {
  appointmentUrl: string
  /**
   * Calendar source for the embedded Google Calendar pane. Either an email /
   * calendar ID (e.g. "you@gmail.com" or "abcdef@group.calendar.google.com"),
   * which is interpolated into the embed URL, OR a full URL starting with
   * "https://" (lets the operator paste a preformatted embed URL with their
   * own ctz / mode params).
   *
   * Note: Google Calendar's main app sets X-Frame-Options: SAMEORIGIN and
   * refuses to iframe. The /calendar/embed endpoint we build below is the
   * supported public embedding path.
   */
  calendarSrc: string
  /**
   * Google Drive folder ID for the embedded Drive pane. Find this in any
   * Drive folder URL: drive.google.com/drive/folders/<THIS-PART>. Embeds via
   * drive.google.com/embeddedfolderview which is read-only by design — the
   * main Drive app refuses to iframe, same X-Frame-Options situation as
   * Calendar. Empty ⇒ Drive tab shows a configure CTA.
   */
  driveFolderId: string
  /** Whether the right pane is shown at all. Toggled from the top bar. */
  rightPaneOpen: boolean
  /** Which tab the right pane shows when open. */
  rightPaneTab: RightPaneTab
}

function defaultSettings(): OperatorSettings {
  return {
    appointmentUrl: '',
    calendarSrc: '',
    driveFolderId: '',
    rightPaneOpen: true,
    rightPaneTab: 'calendar',
  }
}

function loadSettings(): OperatorSettings {
  const fb = defaultSettings()
  if (typeof window === 'undefined') return fb
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (!raw) return fb
    const parsed = JSON.parse(raw) as Partial<OperatorSettings>
    return {
      appointmentUrl: typeof parsed.appointmentUrl === 'string' ? parsed.appointmentUrl : fb.appointmentUrl,
      calendarSrc: typeof parsed.calendarSrc === 'string' ? parsed.calendarSrc : fb.calendarSrc,
      driveFolderId: typeof parsed.driveFolderId === 'string' ? parsed.driveFolderId : fb.driveFolderId,
      rightPaneOpen: typeof parsed.rightPaneOpen === 'boolean' ? parsed.rightPaneOpen : fb.rightPaneOpen,
      rightPaneTab:
        parsed.rightPaneTab === 'calendar' || parsed.rightPaneTab === 'drive'
          ? parsed.rightPaneTab
          : fb.rightPaneTab,
    }
  } catch {
    return fb
  }
}

// Drive folder embed URL. The operator pastes a folder ID (the chunk after
// /drive/folders/ in any Drive URL) — we build the embeddedfolderview URL
// which IS iframe-able. #list = list view, #grid = thumbnails.
function buildDriveEmbedUrl(folderId: string): string | null {
  const trimmed = folderId.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(trimmed)}#list`
}

// Build the iframe-friendly embed URL from a calendar source the operator
// pasted in settings. If they pasted a full URL we trust it; otherwise we
// treat the input as a calendar ID and template into Google's public embed
// path. ctz defaults to the browser's tz so the agenda shows local times.
function buildCalendarEmbedUrl(src: string): string | null {
  const trimmed = src.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  const tz =
    typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : 'America/Los_Angeles'
  const params = new URLSearchParams({
    src: trimmed,
    ctz: tz,
    mode: 'AGENDA',
    showTitle: '0',
    showCalendars: '0',
    showTabs: '0',
    showPrint: '0',
    showNav: '1',
    showDate: '1',
  })
  return `https://calendar.google.com/calendar/embed?${params.toString()}`
}

function App() {
  const [folder, setFolder] = useState<FolderKey>('pending')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  // STAQPRO-412 — VIP sender lookup. Replaces the old per-draft "stars" state
  // (which was visual-only) with a per-sender VIP map that drives the urgency
  // engine's `vip` signal. Persists to localStorage so sandbox iterations
  // survive refresh. Phase 2 port lands `mailbox.vip_senders` + CRUD.
  const [vips, setVips] = useState<VipMap>(() => {
    try {
      const raw = localStorage.getItem('mailbox-sandbox-vips-v1')
      if (raw) return JSON.parse(raw) as VipMap
    } catch {
      /* ignore */
    }
    return {}
  })
  useEffect(() => {
    try {
      localStorage.setItem('mailbox-sandbox-vips-v1', JSON.stringify(vips))
    } catch {
      /* ignore */
    }
  }, [vips])
  const toggleVip = (addr: string) => {
    setVips((prev) => {
      const next: Record<string, VipEntry> = { ...prev }
      if (addr in next) {
        delete next[addr]
      } else {
        next[addr] = { reason: '', added_at: new Date().toISOString() }
      }
      return next
    })
  }
  const addVip = (email: string, reason: string) => {
    setVips((prev) => ({ ...prev, [email]: { reason, added_at: new Date().toISOString() } }))
  }
  const removeVip = (email: string) => {
    setVips((prev) => {
      const next = { ...prev }
      delete next[email]
      return next
    })
  }
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [settings, setSettings] = useState<OperatorSettings>(() => loadSettings())
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Top-level view switch. 'inbox' = default 3-pane queue; 'tuning' = system
  // tuning page; 'digest' = STAQPRO-404 daily-digest email body mockup. All
  // share the top bar + sidebar; only the main area swaps.
  const [view, setView] = useState<'inbox' | 'tuning' | 'digest' | 'kb' | 'insights' | 'vip' | 'search' | 'audit'>('inbox')
  // STAQPRO-413 — search state. Query updates on every keystroke; pressing
  // Enter or hitting a populated query auto-switches to the search view.
  const [searchQuery, setSearchQuery] = useState('')
  const [searchDirection, setSearchDirection] = useState<'any' | 'inbound' | 'outbound'>('any')

  // STAQPRO-404 — queue filter + sort + classification-override state. The
  // filter chips, urgency badges, and the red-flag header all read off these.
  // Overrides are keyed by draft id and feed back into urgency derivation, so
  // changing a category to/from `escalate` updates the row's signals + score
  // in real time.
  // MBOX-133 — filter + sort now persist via usePreference(): server-backed
  // (GET/PUT /api/operator/preferences/[key]) with localStorage fallback so the
  // selection survives a refresh. The hook stores the serializable projection;
  // we adapt to/from FilterState (Sets) at this boundary so the rest of the
  // component keeps the same filters/setFilters/sort/setSort API.
  const { value: filtersRaw, setValue: setFiltersRaw } = usePreference<SerializedFilters>(
    PREF_QUEUE_FILTERS,
    EMPTY_SERIALIZED_FILTERS,
  )
  const filters = useMemo(() => deserializeFilters(filtersRaw), [filtersRaw])
  const setFilters = useCallback(
    (next: FilterState) => setFiltersRaw(serializeFilters(next)),
    [setFiltersRaw],
  )
  const { value: sort, setValue: setSort } = usePreference<SortKey>(PREF_QUEUE_SORT, 'newest')
  const [overrides, setOverrides] = useState<Record<number, string>>({})

  // Persist settings to localStorage on every change so refreshes survive
  useEffect(() => {
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    } catch {
      /* localStorage unavailable; sandbox-only, ignore */
    }
  }, [settings])

  // STAQPRO-404 — apply per-draft category overrides BEFORE urgency derivation
  // so the filter / sort / urgency badges all reflect the corrected category
  // immediately when the operator flips it inline.
  const overrideRow = (d: DraftRow): DraftRow =>
    overrides[d.id] !== undefined
      ? { ...d, classification_category: overrides[d.id]! }
      : d

  // Drafts filtered by status (folder) only — used both for the rendered list
  // (after applying category filter on top) and for per-category counts.
  const folderFiltered = useMemo(() => {
    const sorted = [...fixtureDrafts]
      .map(overrideRow)
      .sort((a, b) =>
        (b.received_at ?? b.created_at).localeCompare(a.received_at ?? a.created_at),
      )
    if (folder === 'all') return sorted
    return sorted.filter((d) => d.status === folder)
    // overrideRow closes over `overrides`; depend on the map identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, overrides])

  // Each row paired with its derived metadata (signals, score, route, bands).
  // Derived once per folderFiltered change so filter / sort can share it.
  // STAQPRO-412 — synthesize row.is_vip from the VIP lookup before deriving
  // so toggling the star instantly flips the urgency signal + red-flag count.
  const derived = useMemo(
    () =>
      folderFiltered.map((row) => {
        const withVip = (row.from_addr in vips) || row.is_vip === true
          ? { ...row, is_vip: true }
          : row
        return { row: withVip, ...rowDerived(withVip) }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folderFiltered, vips],
  )

  // STAQPRO-404 filter chip counts — computed off the UNFILTERED derived set
  // so chip counts don't collapse to 0 once the user starts toggling. Each
  // count key is `<dimension>:<value>`.
  const filterCounts: FilterCounts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const d of derived) {
      const cat = d.row.classification_category
      c[`category:${cat}`] = (c[`category:${cat}`] ?? 0) + 1
      c[`status:${d.row.status}`] = (c[`status:${d.row.status}`] ?? 0) + 1
      c[`route:${d.route}`] = (c[`route:${d.route}`] ?? 0) + 1
      if (d.confidence_band !== null) {
        c[`confidence:${d.confidence_band}`] = (c[`confidence:${d.confidence_band}`] ?? 0) + 1
      }
      if (d.age_band !== null) {
        c[`age:${d.age_band}`] = (c[`age:${d.age_band}`] ?? 0) + 1
      }
    }
    return c
  }, [derived])

  // Apply the FilterBar's multi-select sets. Empty set per dimension = pass-all.
  const matchesFilters = (d: typeof derived[number]): boolean => {
    if (filters.categories.size > 0 && !filters.categories.has(d.row.classification_category)) return false
    if (filters.statuses.size > 0 && !filters.statuses.has(d.row.status)) return false
    if (filters.routes.size > 0 && !filters.routes.has(d.route)) return false
    if (filters.confidence_bands.size > 0) {
      if (d.confidence_band === null || !filters.confidence_bands.has(d.confidence_band)) return false
    }
    if (filters.age_bands.size > 0) {
      if (d.age_band === null || !filters.age_bands.has(d.age_band)) return false
    }
    return true
  }

  // Filtered + sorted.
  const filtered = useMemo(() => {
    const passing = derived.filter(matchesFilters)
    const cmp = (a: typeof derived[number], b: typeof derived[number]): number => {
      const aIso = a.row.received_at ?? a.row.created_at
      const bIso = b.row.received_at ?? b.row.created_at
      if (sort === 'newest') return bIso.localeCompare(aIso)
      if (sort === 'oldest') return aIso.localeCompare(bIso)
      // urgency: score desc, older received_at as tiebreaker
      if (b.urgency_score !== a.urgency_score) return b.urgency_score - a.urgency_score
      return aIso.localeCompare(bIso)
    }
    return [...passing].sort(cmp)
    // matchesFilters closes over filters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived, filters, sort])

  // Urgent-untouched count for the red-flag header — across the visible queue.
  const urgentCount = useMemo(
    () => filtered.filter((d) => isUrgentUntouched(d.row)).length,
    [filtered],
  )

  const counts = useMemo(() => {
    const c: Record<FolderKey, number> = { pending: 0, approved: 0, sent: 0, rejected: 0, all: fixtureDrafts.length }
    for (const d of fixtureDrafts) c[d.status as FolderKey]++
    return c
  }, [])

  const selected = filtered.find((d) => d.row.id === selectedId)?.row ?? null

  return (
    <div className="flex h-full flex-col bg-white text-[13px] text-zinc-800">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-200 px-3">
        <button
          className="rounded-full p-2 text-zinc-600 hover:bg-zinc-100"
          onClick={() => setSidebarOpen((s) => !s)}
          aria-label="Toggle sidebar"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 pr-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-indigo-600 text-white">
            <Sparkles className="h-4 w-4" />
          </div>
          <span className="text-base font-medium tracking-tight text-zinc-700">Sandbox Dashboard</span>
        </div>
        <div className="mx-2 flex h-11 max-w-2xl flex-1 items-center gap-2 rounded-lg bg-zinc-100 px-3 focus-within:bg-white focus-within:ring-1 focus-within:ring-indigo-300">
          <Search className="h-4 w-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search drafts + sent history"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
              if (e.target.value.trim() && view !== 'search') setView('search')
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchQuery.trim()) {
                setView('search')
              }
              if (e.key === 'Escape') {
                setSearchQuery('')
                setView('inbox')
              }
            }}
            className="flex-1 bg-transparent text-sm outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('')
                if (view === 'search') setView('inbox')
              }}
              className="text-[11px] text-zinc-500 hover:text-zinc-700"
              title="Clear search"
            >
              clear
            </button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              setSettings((prev) => ({ ...prev, rightPaneOpen: !prev.rightPaneOpen }))
            }
            title={settings.rightPaneOpen ? 'Hide right pane' : 'Show right pane'}
            className={clsx(
              'rounded-full p-2 transition-colors',
              settings.rightPaneOpen
                ? 'text-zinc-600 hover:bg-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-100',
            )}
            aria-pressed={settings.rightPaneOpen}
          >
            {settings.rightPaneOpen ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRight className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            className="rounded-full p-2 text-zinc-600 hover:bg-zinc-100"
          >
            <Settings className="h-4 w-4" />
          </button>
          <span className="hidden text-xs text-zinc-500 md:inline">M1 · Heron Labs</span>
          <div className="h-8 w-8 rounded-full bg-amber-500 text-center text-sm font-medium leading-8 text-white">D</div>
        </div>
      </header>

      {settingsOpen && (
        <SettingsModal
          settings={settings}
          onSave={(next) => {
            setSettings(next)
            setSettingsOpen(false)
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <div className="flex min-h-0 flex-1">
        {/* Sidebar */}
        {sidebarOpen && (
          <aside className="flex w-60 shrink-0 flex-col gap-1 border-r border-zinc-200 px-2 py-3">
            <button
              type="button"
              className="mb-2 flex h-12 items-center gap-3 self-start rounded-2xl bg-indigo-600 pr-6 pl-4 text-sm font-medium text-white shadow-sm hover:shadow"
            >
              <Pencil className="h-4 w-4" />
              Compose
            </button>
            {FOLDERS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => {
                  setFolder(key)
                  setSelectedId(null)
                  setView('inbox')
                }}
                className={clsx(
                  'flex h-9 items-center gap-3 rounded-r-full pr-3 pl-5 text-sm transition-colors',
                  view === 'inbox' && folder === key
                    ? 'bg-indigo-50 font-medium text-indigo-900'
                    : 'text-zinc-700 hover:bg-zinc-100',
                )}
              >
                <Icon className="h-4 w-4" />
                <span className="flex-1 text-left">{label}</span>
                {counts[key] > 0 && (
                  <span className={clsx('text-xs', view === 'inbox' && folder === key ? 'text-indigo-700' : 'text-zinc-500')}>
                    {counts[key]}
                  </span>
                )}
              </button>
            ))}

            {/* Top-level view nav entry — switches the main area to the Tuning page. */}
            <button
              type="button"
              onClick={() => setView('tuning')}
              className={clsx(
                'mt-1 flex h-9 items-center gap-3 rounded-r-full pr-3 pl-5 text-sm transition-colors',
                view === 'tuning'
                  ? 'bg-indigo-50 font-medium text-indigo-900'
                  : 'text-zinc-700 hover:bg-zinc-100',
              )}
            >
              <SlidersHorizontal className="h-4 w-4" />
              <span className="flex-1 text-left">Tuning</span>
            </button>

            {/* STAQPRO-404 deliverable #6 — daily digest email body mockup,
                rendered as a sandbox view via the existing view-state switch
                (no router needed). */}
            <button
              type="button"
              onClick={() => setView('digest')}
              className={clsx(
                'flex h-9 items-center gap-3 rounded-r-full pr-3 pl-5 text-sm transition-colors',
                view === 'digest'
                  ? 'bg-indigo-50 font-medium text-indigo-900'
                  : 'text-zinc-700 hover:bg-zinc-100',
              )}
            >
              <FileText className="h-4 w-4" />
              <span className="flex-1 text-left">Digest preview</span>
            </button>

            {/* STAQPRO-404 follow-up — Knowledge Base nav stub. Mirrors the
                prod page at /dashboard/knowledge-base (STAQPRO-148). Sandbox
                fidelity = layout + fixtures only. */}
            <button
              type="button"
              onClick={() => setView('kb')}
              className={clsx(
                'flex h-9 items-center gap-3 rounded-r-full pr-3 pl-5 text-sm transition-colors',
                view === 'kb'
                  ? 'bg-indigo-50 font-medium text-indigo-900'
                  : 'text-zinc-700 hover:bg-zinc-100',
              )}
            >
              <BookOpen className="h-4 w-4" />
              <span className="flex-1 text-left">Knowledge base</span>
            </button>

            {/* STAQPRO-411 — Insights / weekly value rollup. Sandbox surface
                for the eventual /dashboard/insights route. */}
            <button
              type="button"
              onClick={() => setView('insights')}
              className={clsx(
                'flex h-9 items-center gap-3 rounded-r-full pr-3 pl-5 text-sm transition-colors',
                view === 'insights'
                  ? 'bg-indigo-50 font-medium text-indigo-900'
                  : 'text-zinc-700 hover:bg-zinc-100',
              )}
            >
              <BarChart3 className="h-4 w-4" />
              <span className="flex-1 text-left">Insights</span>
            </button>

            {/* STAQPRO-412 — VIP sender management. Star icon mirrors the
                queue-row toggle. */}
            <button
              type="button"
              onClick={() => setView('vip')}
              className={clsx(
                'flex h-9 items-center gap-3 rounded-r-full pr-3 pl-5 text-sm transition-colors',
                view === 'vip'
                  ? 'bg-indigo-50 font-medium text-indigo-900'
                  : 'text-zinc-700 hover:bg-zinc-100',
              )}
            >
              <Star className={clsx('h-4 w-4', Object.keys(vips).length > 0 && 'fill-amber-400 text-amber-500')} />
              <span className="flex-1 text-left">VIP senders</span>
              {Object.keys(vips).length > 0 && (
                <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-medium text-amber-700">
                  {Object.keys(vips).length}
                </span>
              )}
            </button>

            {/* STAQPRO-414 — Audit log viewer. Sandbox surface for
                mailbox.state_transitions feed; per-draft history reachable
                via row's draft-id pill. */}
            <button
              type="button"
              onClick={() => setView('audit')}
              className={clsx(
                'flex h-9 items-center gap-3 rounded-r-full pr-3 pl-5 text-sm transition-colors',
                view === 'audit'
                  ? 'bg-indigo-50 font-medium text-indigo-900'
                  : 'text-zinc-700 hover:bg-zinc-100',
              )}
            >
              <History className="h-4 w-4" />
              <span className="flex-1 text-left">Audit log</span>
            </button>

          </aside>
        )}

        {/* Main — 3-pane inbox, Tuning page, or Digest preview, depending on `view`.
            Pane sizes persisted to localStorage by react-resizable-panels via autoSaveId. */}
        {view === 'tuning' && (
          <TuningPage onBack={() => setView('inbox')} />
        )}
        {view === 'digest' && (
          <DigestPreview onBack={() => setView('inbox')} />
        )}
        {view === 'kb' && (
          <KnowledgeBasePage onBack={() => setView('inbox')} />
        )}
        {view === 'insights' && (
          <InsightsPage onBack={() => setView('inbox')} />
        )}
        {view === 'vip' && (
          <VipManagementPage
            vips={vips}
            onAdd={addVip}
            onRemove={removeVip}
            onBack={() => setView('inbox')}
          />
        )}
        {view === 'search' && (
          <SearchResultsPage
            query={searchQuery}
            directionFilter={searchDirection}
            onDirectionChange={setSearchDirection}
            onOpenDraft={(id) => {
              setSelectedId(id)
              setView('inbox')
            }}
            onBack={() => setView('inbox')}
          />
        )}
        {view === 'audit' && (
          <AuditPage
            onBack={() => setView('inbox')}
            onOpenDraft={(id) => {
              setSelectedId(id)
              setView('inbox')
            }}
          />
        )}
        {view === 'inbox' && (
        <main className="flex min-w-0 flex-1">
          <PanelGroup direction="horizontal" autoSaveId="mailbox-sandbox-main-panes-v1" className="flex min-w-0 flex-1">
          {/* List pane */}
          <Panel defaultSize={35} minSize={20} order={1}>
          <section className="flex h-full min-w-0 flex-col">
            {/* STAQPRO-404 header band — red-flag chip on the left, sort segmented
                control on the right (design choice: same horizontal band keeps
                the queue header dense; FilterBar gets its own row underneath). */}
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-3">
              <RedFlagHeader
                urgentCount={urgentCount}
                total={filtered.length}
                onClick={() => {
                  // One-click drill-in: filter to pending only + clear other dims.
                  setFilters({
                    ...EMPTY_FILTERS,
                    statuses: new Set<DraftStatus>(['pending']),
                  })
                  setSort('urgency')
                }}
              />
              <div className="ml-auto">
                <SortControls sort={sort} onChange={setSort} />
              </div>
            </div>

            {/* STAQPRO-404 — multi-select filter chips bar. */}
            <FilterBar filters={filters} onChange={setFilters} counts={filterCounts} />

            {/* Toolbar */}
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 px-2">
              <input type="checkbox" className="ml-2 h-4 w-4 accent-indigo-600" />
              <button className="rounded-full p-2 text-zinc-600 hover:bg-zinc-100" title="Refresh">
                <RefreshCw className="h-4 w-4" />
              </button>
              <button className="rounded-full p-2 text-zinc-600 hover:bg-zinc-100" title="More">
                <MoreVertical className="h-4 w-4" />
              </button>
              <div className="ml-auto flex items-center gap-1 pr-2 text-xs text-zinc-600">
                <span>1–{filtered.length} of {filtered.length}</span>
                {filtersActive(filters) && (
                  <button
                    type="button"
                    onClick={() => setFilters(EMPTY_FILTERS)}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium text-indigo-600 hover:bg-indigo-50"
                    title="Clear filters"
                  >
                    filtered
                  </button>
                )}
                <button className="rounded-full p-1.5 hover:bg-zinc-100"><ChevronLeft className="h-4 w-4" /></button>
                <button className="rounded-full p-1.5 hover:bg-zinc-100"><ChevronRight className="h-4 w-4" /></button>
              </div>
            </div>

            {/* List */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {filtered.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-500">
                  {folderFiltered.length === 0 ? (
                    <span>Nothing in {FOLDERS.find((f) => f.key === folder)?.label.toLowerCase()}.</span>
                  ) : (
                    <span>
                      No {FOLDERS.find((f) => f.key === folder)?.label.toLowerCase()} drafts match the current filters.
                    </span>
                  )}
                </div>
              )}
              {filtered.map((entry) => {
                const d = entry.row
                const isUnread = d.status === 'pending'
                const isSelected = d.id === selectedId
                const isStarred = d.from_addr in vips
                const isChecked = checked[d.id] ?? false
                return (
                  <button
                    key={d.id}
                    onClick={() => setSelectedId(d.id)}
                    className={clsx(
                      'group flex w-full items-center gap-2 border-b border-zinc-100 px-2 py-2 text-left',
                      isSelected ? 'bg-indigo-50' : 'hover:bg-zinc-50',
                      isUnread && !isSelected && 'bg-white',
                    )}
                  >
                    {/* Avatar bubble in compact view, checkbox on hover */}
                    <div className="relative w-7 shrink-0">
                      <div
                        className={clsx(
                          'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-white transition-opacity',
                          senderColor(d.from_addr),
                          'group-hover:opacity-0',
                          isChecked && 'opacity-0',
                        )}
                      >
                        {senderInitial(d.from_addr)}
                      </div>
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          e.stopPropagation()
                          setChecked((s) => ({ ...s, [d.id]: e.target.checked }))
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className={clsx(
                          'absolute inset-1 h-5 w-5 accent-indigo-600 transition-opacity',
                          'opacity-0 group-hover:opacity-100',
                          isChecked && 'opacity-100',
                        )}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        toggleVip(d.from_addr)
                      }}
                      className="shrink-0 p-1 text-zinc-400 hover:text-amber-500"
                      title={isStarred ? `Unmark ${d.from_addr} as VIP` : `Mark ${d.from_addr} as VIP`}
                    >
                      <Star className={clsx('h-4 w-4', isStarred && 'fill-amber-400 text-amber-500')} />
                    </button>

                    {!selected && (
                      <span className={clsx('w-44 shrink-0 truncate', isUnread ? 'font-semibold text-zinc-900' : 'text-zinc-700')}>
                        {senderName(d.from_addr)}
                      </span>
                    )}

                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      {/* STAQPRO-404 — inline classification override (popover). */}
                      <span
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0"
                      >
                        <ClassificationOverride
                          value={d.classification_category}
                          onChange={(next) =>
                            setOverrides((prev) => ({ ...prev, [d.id]: next }))
                          }
                          categories={ALL_CATEGORIES}
                          pillClasses={CATEGORY_COLORS[d.classification_category] ?? CATEGORY_COLORS.unknown}
                          optionClasses={(cat) =>
                            CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.unknown
                          }
                        />
                      </span>

                      {/* STAQPRO-404 — per-row urgency badge (null when 0 signals). */}
                      <UrgencyBadge signals={entry.signals} />

                      <div className="flex min-w-0 flex-1 items-baseline gap-2">
                        <span className={clsx('shrink truncate', isUnread ? 'font-semibold text-zinc-900' : 'text-zinc-700')}>
                          {selected && (
                            <span className="mr-1 text-zinc-500">{senderName(d.from_addr)} ·</span>
                          )}
                          {d.subject || '(no subject)'}
                        </span>
                        <span className="hidden min-w-0 truncate text-zinc-500 md:inline">
                          — {snippetFromDraft(d)}
                        </span>
                      </div>
                    </div>

                    <span
                      className={clsx(
                        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ring-1',
                        STATUS_COLORS[d.status],
                      )}
                    >
                      {d.status}
                    </span>

                    <span className={clsx('w-16 shrink-0 text-right text-xs', isUnread ? 'font-semibold text-zinc-900' : 'text-zinc-500')}>
                      {formatDate(d.received_at ?? d.created_at)}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>
          </Panel>

          <PanelResizeHandle className="group relative w-px bg-zinc-200 transition-colors data-[resize-handle-state=hover]:bg-indigo-300 data-[resize-handle-state=drag]:bg-indigo-400">
            <span className="absolute inset-y-0 -left-1 -right-1 z-10" />
          </PanelResizeHandle>

          {/* Detail pane */}
          <Panel defaultSize={35} minSize={20} order={2}>
            <section className="flex h-full min-w-0 flex-1 flex-col bg-white">
              {selected ? (
                <DetailPane
                  draft={selected}
                  onClose={() => setSelectedId(null)}
                  appointmentUrl={settings.appointmentUrl}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-zinc-400">
                  <span>Select a draft from the queue to review.</span>
                </div>
              )}
            </section>
          </Panel>

          {settings.rightPaneOpen && (
            <>
              <PanelResizeHandle className="group relative w-px bg-zinc-200 transition-colors data-[resize-handle-state=hover]:bg-indigo-300 data-[resize-handle-state=drag]:bg-indigo-400">
                <span className="absolute inset-y-0 -left-1 -right-1 z-10" />
              </PanelResizeHandle>

              {/* Right pane — Calendar / Drive tabs */}
              <Panel defaultSize={30} minSize={20} order={3}>
                <RightPane
                  tab={settings.rightPaneTab}
                  onTabChange={(t) =>
                    setSettings((prev) => ({ ...prev, rightPaneTab: t }))
                  }
                  onClose={() =>
                    setSettings((prev) => ({ ...prev, rightPaneOpen: false }))
                  }
                  calendarSrc={settings.calendarSrc}
                  driveFolderId={settings.driveFolderId}
                  onConfigure={() => setSettingsOpen(true)}
                />
              </Panel>
            </>
          )}
          </PanelGroup>
        </main>
        )}
      </div>
    </div>
  )
}

// Right pane — tabbed shell that holds Calendar and Drive sub-views.
// Both Google Calendar and Google Drive's main apps refuse to iframe
// (X-Frame-Options: SAMEORIGIN); the embed endpoints used here are the
// supported public iframe paths. Header has tab switcher + close button +
// "open in new tab" link to the full Google app for the active tab.
function RightPane({
  tab,
  onTabChange,
  onClose,
  calendarSrc,
  driveFolderId,
  onConfigure,
}: {
  tab: RightPaneTab
  onTabChange: (t: RightPaneTab) => void
  onClose: () => void
  calendarSrc: string
  driveFolderId: string
  onConfigure: () => void
}) {
  const calendarEmbedUrl = buildCalendarEmbedUrl(calendarSrc)
  const driveEmbedUrl = buildDriveEmbedUrl(driveFolderId)
  const externalUrl =
    tab === 'calendar'
      ? 'https://calendar.google.com/calendar/u/0/r'
      : driveFolderId.trim()
        ? `https://drive.google.com/drive/folders/${encodeURIComponent(driveFolderId.trim())}`
        : 'https://drive.google.com/drive/u/0/my-drive'

  return (
    <div className="flex h-full flex-col">
      {/* Header: tab strip + actions */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-zinc-200 px-2">
        <RightPaneTabButton
          active={tab === 'calendar'}
          onClick={() => onTabChange('calendar')}
          icon={<Calendar className="h-3.5 w-3.5" />}
          label="Calendar"
        />
        <RightPaneTabButton
          active={tab === 'drive'}
          onClick={() => onTabChange('drive')}
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          label="Drive"
        />
        <a
          href={externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open Google ${tab === 'calendar' ? 'Calendar' : 'Drive'} in a new tab`}
          className="ml-auto rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <button
          type="button"
          onClick={onClose}
          title="Hide right pane"
          className="rounded-full p-1.5 text-zinc-500 hover:bg-zinc-100"
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Body — render the matching sub-view */}
      {tab === 'calendar' ? (
        calendarEmbedUrl ? (
          <iframe
            title="Google Calendar"
            src={calendarEmbedUrl}
            className="min-h-0 flex-1 border-0"
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-same-origin"
          />
        ) : (
          <PaneEmptyState
            icon={<CalendarPlus className="h-10 w-10 text-zinc-300" />}
            title="No calendar configured"
            description="Paste your Google Calendar email or calendar ID in Settings to embed your agenda here. Private events show 'Busy' placeholders unless your calendar's sharing is set to 'See all event details' for the embed source."
            onConfigure={onConfigure}
          />
        )
      ) : driveEmbedUrl ? (
        <iframe
          title="Google Drive"
          src={driveEmbedUrl}
          className="min-h-0 flex-1 border-0"
          sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-same-origin"
        />
      ) : (
        <PaneEmptyState
          icon={<FolderOpen className="h-10 w-10 text-zinc-300" />}
          title="No Drive folder configured"
          description="Drop a Google Drive folder ID in Settings (the part after /drive/folders/ in any folder URL). The embed shows file listings — clicking a file opens it in a new tab. The folder must be shared with anyone you want viewing it (or you must be signed in to the same Google account in this browser)."
          onConfigure={onConfigure}
        />
      )}
    </div>
  )
}

function RightPaneTabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors',
        active
          ? 'bg-indigo-50 font-medium text-indigo-700'
          : 'text-zinc-600 hover:bg-zinc-100',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

function PaneEmptyState({
  icon,
  title,
  description,
  onConfigure,
}: {
  icon: React.ReactNode
  title: string
  description: string
  onConfigure: () => void
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {icon}
      <div className="text-sm font-medium text-zinc-700">{title}</div>
      <p className="max-w-xs text-xs text-zinc-500">{description}</p>
      <button
        type="button"
        onClick={onConfigure}
        className="mt-1 inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-indigo-700"
      >
        <Settings className="h-3.5 w-3.5" />
        Open Settings
      </button>
    </div>
  )
}

function DetailPane({
  draft,
  onClose,
  appointmentUrl,
}: {
  draft: DraftRow
  onClose: () => void
  appointmentUrl: string
}) {
  const [editedBody, setEditedBody] = useState(draft.draft_body)
  const [redraftOpen, setRedraftOpen] = useState(false)
  const [chat, setChat] = useState<ChatMsg[]>([])
  const [prompt, setPrompt] = useState('')
  const [pending, setPending] = useState(false)
  const [redraftError, setRedraftError] = useState<string | null>(null)
  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectReason, setRejectReason] = useState<RejectReasonCode | null>(null)
  const [rejectNote, setRejectNote] = useState('')
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const rejectRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Reset local state when switching to a different draft
  useEffect(() => {
    abortRef.current?.abort()
    setEditedBody(draft.draft_body)
    setRedraftOpen(false)
    setChat([])
    setPrompt('')
    setPending(false)
    setRedraftError(null)
    setRejectOpen(false)
    setRejectReason(null)
    setRejectNote('')
  }, [draft.id, draft.draft_body])

  // Close reject popover on outside-click / Esc
  useEffect(() => {
    if (!rejectOpen) return
    function handleClick(e: MouseEvent) {
      if (rejectRef.current && !rejectRef.current.contains(e.target as Node)) {
        setRejectOpen(false)
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setRejectOpen(false)
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [rejectOpen])

  // Auto-resize the editable draft body to fit content
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [editedBody])

  // Auto-resize the redraft prompt input
  useEffect(() => {
    const el = promptRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [prompt, redraftOpen])

  const isDirty = editedBody !== draft.draft_body
  const lastAssistant = [...chat].reverse().find((m) => m.role === 'assistant')

  async function submitRedraft() {
    const trimmed = prompt.trim()
    if (!trimmed || pending) return
    setChat((prev) => [...prev, { role: 'user', content: trimmed }])
    setPrompt('')
    setPending(true)
    setRedraftError(null)
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const reply = await callRedraft(
        draft.inbound_body_preview ?? '',
        editedBody,
        chat,
        trimmed,
        controller.signal,
        appointmentUrl,
      )
      if (controller.signal.aborted) return
      setChat((prev) => [...prev, { role: 'assistant', content: reply }])
    } catch (err) {
      if (controller.signal.aborted) return
      const msg = err instanceof Error ? err.message : 'Unknown error'
      setRedraftError(msg)
    } finally {
      if (!controller.signal.aborted) setPending(false)
    }
  }

  function applyAssistant(content: string) {
    setEditedBody(content)
  }

  function submitReject() {
    if (!rejectReason) return
    if (rejectReason === 'other' && !rejectNote.trim()) return
    const payload = {
      draft_id: draft.id,
      reason_code: rejectReason,
      free_text: rejectNote.trim() || null,
      rejected_at: new Date().toISOString(),
    }
    // Sandbox capture-only. Production: POST /api/drafts/:id/reject with this
    // shape → writes mailbox.draft_feedback for persona + RAG + classifier loops.
    // eslint-disable-next-line no-console
    console.log('[reject]', payload)
    setRejectOpen(false)
    setRejectReason(null)
    setRejectNote('')
  }

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-200 px-3">
        <button onClick={onClose} className="rounded-full p-2 text-zinc-600 hover:bg-zinc-100">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="truncate text-sm font-medium text-zinc-800">{draft.subject || '(no subject)'}</span>
        <div className="ml-auto flex items-center gap-1">
          <span
            className={clsx(
              'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ring-1',
              STATUS_COLORS[draft.status],
            )}
          >
            {draft.status}
          </span>
          <span
            className={clsx(
              'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ring-1',
              CATEGORY_COLORS[draft.classification_category] ?? CATEGORY_COLORS.unknown,
            )}
          >
            {draft.classification_category}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Prior thread messages — collapsed-by-default, stacked oldest first above the current inbound. */}
        {draft.prior_messages && draft.prior_messages.length > 0 && (
          <div className="border-b border-zinc-200 bg-zinc-50/40">
            <div className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              Earlier in this conversation · {draft.prior_messages.length}
            </div>
            {[...draft.prior_messages]
              .sort((a, b) => a.at.localeCompare(b.at))
              .map((m, idx) => (
                <details
                  key={`${m.direction}-${m.at}-${idx}`}
                  className="group/msg border-t border-zinc-200/80 first:border-t-0"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2 hover:bg-zinc-100/60">
                    <div
                      className={clsx(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white',
                        m.direction === 'outbound' ? 'bg-zinc-500' : senderColor(m.from_addr),
                      )}
                    >
                      {m.direction === 'outbound' ? 'M' : senderInitial(m.from_addr)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium text-zinc-700">
                          {m.direction === 'outbound' ? 'me' : senderName(m.from_addr)}
                        </span>
                        <span className="truncate text-xs text-zinc-400">
                          &lt;{m.from_addr}&gt;
                        </span>
                      </div>
                      <div className="text-xs text-zinc-400">
                        {m.direction === 'outbound' ? 'sent' : 'to me'} · {formatDate(m.at)}
                      </div>
                    </div>
                    <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400 transition-transform group-open/msg:rotate-180" />
                  </summary>
                  <div className="px-6 pb-4 pt-0">
                    <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-zinc-700">
                      {m.body}
                    </pre>
                  </div>
                </details>
              ))}
          </div>
        )}

        {/* Inbound message — open by default; collapse if you want to focus on the draft */}
        <details open className="group border-b border-zinc-200">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 hover:bg-zinc-50">
            <div
              className={clsx(
                'flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white',
                senderColor(draft.from_addr),
              )}
            >
              {senderInitial(draft.from_addr)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate font-medium text-zinc-900">{senderName(draft.from_addr)}</span>
                <span className="truncate text-xs text-zinc-500">&lt;{draft.from_addr}&gt;</span>
              </div>
              <div className="text-xs text-zinc-500">to me · {formatDate(draft.received_at)}</div>
            </div>
            <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500 transition-transform group-open:rotate-180" />
          </summary>
          <div className="px-6 pb-5 pt-0">
            <pre className="whitespace-pre-wrap break-words font-sans text-[14px] leading-relaxed text-zinc-800">
              {draft.inbound_body_preview || '(empty)'}
            </pre>
            <div className="mt-3 text-[11px] text-zinc-400">— preview truncated to 600 chars</div>
          </div>
        </details>

        {/* Reply attribution divider — Gmail-style "On <date>, <sender> wrote:" feel */}
        <div className="flex items-center gap-3 px-6 pt-4 text-xs text-zinc-500">
          <span className="h-px flex-1 bg-zinc-200" />
          <span className="inline-flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 text-indigo-500" />
            <span>AI draft reply</span>
            <span className="text-zinc-400">· {draft.model} · confidence {draft.classification_confidence ?? '—'}</span>
          </span>
          <span className="h-px flex-1 bg-zinc-200" />
        </div>

        {/* AI draft — always expanded, primary action area, editable inline */}
        <article className="px-6 py-5">
          {draft.draft_subject && (
            <div className="mb-3 text-xs text-zinc-500">
              Subject: <span className="text-zinc-800">{draft.draft_subject}</span>
            </div>
          )}
          <textarea
            ref={bodyRef}
            value={editedBody}
            onChange={(e) => setEditedBody(e.target.value)}
            spellCheck
            className="w-full resize-none whitespace-pre-wrap break-words bg-transparent font-sans text-[14px] leading-relaxed text-zinc-800 outline-none focus:ring-0"
            aria-label="Draft body — editable"
          />
          {isDirty && (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-amber-700">
              <Pencil className="h-3 w-3" />
              <span>Edited — Approve &amp; Send will use your edited copy.</span>
              <button
                type="button"
                onClick={() => setEditedBody(draft.draft_body)}
                className="underline-offset-2 hover:underline"
              >
                Revert to original
              </button>
            </div>
          )}
        </article>

        {/* Redraft conversation panel — opens when "Redraft with prompt" is clicked */}
        {redraftOpen && (
          <section className="border-t border-indigo-100 bg-indigo-50/40 px-6 py-4">
            <div className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-indigo-700">
              <Wand2 className="h-3.5 w-3.5" />
              <span>Redraft with prompt</span>
              <span className="text-indigo-400">· {draft.model}</span>
              <button
                type="button"
                onClick={() => setRedraftOpen(false)}
                className="ml-auto rounded-full p-1 text-indigo-500 hover:bg-indigo-100"
                aria-label="Close redraft panel"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {chat.length === 0 && !pending && (
              <p className="mb-3 text-xs text-zinc-600">
                Tell the model how to redraft this reply. It sees your current draft (including any edits) plus
                this conversation. Try: "make it more formal", "shorter", "warmer", or specific edits like
                "mention that we're shipping Friday."
              </p>
            )}

            {/* Chat thread */}
            {chat.length > 0 && (
              <ol className="mb-3 space-y-3">
                {chat.map((m, i) => (
                  <li
                    key={i}
                    className={clsx(
                      'rounded-lg border px-3 py-2 text-[13px] leading-relaxed',
                      m.role === 'user'
                        ? 'border-zinc-200 bg-white text-zinc-800'
                        : 'border-indigo-200 bg-white text-zinc-800',
                    )}
                  >
                    <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide">
                      {m.role === 'user' ? (
                        <span className="text-zinc-500">You</span>
                      ) : (
                        <>
                          <Sparkles className="h-3 w-3 text-indigo-500" />
                          <span className="text-indigo-600">{draft.model}</span>
                        </>
                      )}
                    </div>
                    <pre className="whitespace-pre-wrap break-words font-sans">{m.content}</pre>
                    {m.role === 'assistant' && (
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => applyAssistant(m.content)}
                          disabled={editedBody === m.content}
                          className={clsx(
                            'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium ring-1',
                            editedBody === m.content
                              ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                              : 'bg-indigo-600 text-white ring-indigo-700 hover:bg-indigo-700',
                          )}
                        >
                          {editedBody === m.content ? (
                            <>
                              <Check className="h-3 w-3" /> Applied
                            </>
                          ) : (
                            <>Use this draft</>
                          )}
                        </button>
                        {m === lastAssistant && (
                          <button
                            type="button"
                            onClick={() => {
                              setChat((prev) => prev.filter((x) => x !== m))
                              setPrompt('Try again with a different angle')
                            }}
                            className="text-[11px] text-zinc-500 hover:text-zinc-700"
                          >
                            Try again
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                ))}
                {pending && (
                  <li className="rounded-lg border border-indigo-200 bg-white px-3 py-2 text-[13px] text-zinc-500">
                    <div className="flex items-center gap-2">
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-500" />
                      <span>{draft.model} is redrafting…</span>
                    </div>
                  </li>
                )}
              </ol>
            )}

            {/* Error surface */}
            {redraftError && (
              <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">
                <div className="font-medium">Redraft failed</div>
                <div className="mt-0.5 text-rose-600">{redraftError}</div>
                <div className="mt-1 text-[11px] text-rose-500">
                  Check that the dev server can reach M1's Ollama at <code>192.168.50.179:11434</code>.
                  Override with <code>OLLAMA_TARGET=…</code> in the env when starting <code>pnpm dev</code>.
                </div>
              </div>
            )}

            {/* Prompt input */}
            <div className="flex items-end gap-2 rounded-xl border border-zinc-300 bg-white p-2 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100">
              <textarea
                ref={promptRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    submitRedraft()
                  }
                }}
                placeholder={chat.length === 0 ? 'How should I redraft this?' : 'Iterate further…'}
                rows={1}
                className="flex-1 resize-none bg-transparent text-sm leading-relaxed text-zinc-800 outline-none placeholder:text-zinc-400"
              />
              <button
                type="button"
                onClick={submitRedraft}
                disabled={!prompt.trim() || pending}
                className={clsx(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors',
                  prompt.trim() && !pending
                    ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                    : 'bg-zinc-200 text-zinc-400',
                )}
                aria-label="Submit redraft prompt"
              >
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </button>
            </div>
            <div className="mt-1.5 text-[10px] text-zinc-400">⌘/Ctrl + Enter to send</div>
          </section>
        )}

        {/* Metadata — collapsed by default, native disclosure */}
        <details className="group border-t border-zinc-200">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-3 text-xs uppercase tracking-wide text-zinc-500 hover:bg-zinc-50">
            <span>Draft details</span>
            <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
          </summary>
          <dl className="grid grid-cols-[140px_1fr] gap-y-2 px-6 pb-5 text-sm">
            <dt className="text-zinc-500">Draft id</dt><dd className="text-zinc-800">#{draft.id}</dd>
            <dt className="text-zinc-500">Status</dt><dd className="text-zinc-800">{draft.status}</dd>
            <dt className="text-zinc-500">Source</dt><dd className="text-zinc-800">{draft.draft_source}</dd>
            <dt className="text-zinc-500">Model</dt><dd className="text-zinc-800">{draft.model}</dd>
            <dt className="text-zinc-500">Category</dt><dd className="text-zinc-800">{draft.classification_category}</dd>
            <dt className="text-zinc-500">Confidence</dt><dd className="text-zinc-800">{draft.classification_confidence ?? '—'}</dd>
            <dt className="text-zinc-500">Received</dt><dd className="text-zinc-800">{draft.received_at ?? '—'}</dd>
            <dt className="text-zinc-500">Drafted</dt><dd className="text-zinc-800">{draft.created_at}</dd>
            {draft.approved_at && <><dt className="text-zinc-500">Approved</dt><dd className="text-zinc-800">{draft.approved_at}</dd></>}
            {draft.sent_at && <><dt className="text-zinc-500">Sent</dt><dd className="text-zinc-800">{draft.sent_at}</dd></>}
          </dl>
        </details>
      </div>

      {/* Action bar — sticky bottom */}
      <div className="flex shrink-0 items-center gap-2 border-t border-zinc-200 bg-white px-4 py-3">
        <button
          type="button"
          className="flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
        >
          <Send className="h-4 w-4" /> Approve &amp; Send
          {isDirty && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-300" />}
        </button>
        <button
          type="button"
          onClick={() => {
            setRedraftOpen((v) => !v)
            // focus the prompt input after the panel renders
            setTimeout(() => promptRef.current?.focus(), 50)
          }}
          className={clsx(
            'flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors',
            redraftOpen
              ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
              : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50',
          )}
        >
          <Wand2 className="h-4 w-4" /> Redraft with prompt
          {chat.length > 0 && (
            <span className="ml-1 rounded-full bg-indigo-100 px-1.5 text-[10px] font-semibold text-indigo-700">
              {chat.filter((m) => m.role === 'user').length}
            </span>
          )}
        </button>
        <div ref={rejectRef} className="relative">
          <button
            type="button"
            onClick={() => setRejectOpen((v) => !v)}
            className={clsx(
              'flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition-colors',
              rejectOpen
                ? 'border-rose-300 bg-rose-50 text-rose-700'
                : 'border-zinc-300 text-zinc-700 hover:bg-zinc-50',
            )}
          >
            <X className="h-4 w-4" /> Reject
          </button>
          {rejectOpen && (
            <div className="absolute bottom-full right-0 z-20 mb-2 w-80 rounded-xl border border-zinc-200 bg-white p-3 shadow-lg">
              <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                Why reject this draft?
              </div>
              <div className="space-y-0.5">
                {REJECT_REASONS.map((r) => (
                  <label
                    key={r.code}
                    className={clsx(
                      'flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-zinc-50',
                      rejectReason === r.code && 'bg-rose-50/60',
                    )}
                  >
                    <input
                      type="radio"
                      name="reject-reason"
                      value={r.code}
                      checked={rejectReason === r.code}
                      onChange={() => setRejectReason(r.code)}
                      className="mt-1 accent-rose-600"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-zinc-800">{r.label}</div>
                      {r.hint && <div className="text-[11px] text-zinc-400">{r.hint}</div>}
                    </div>
                  </label>
                ))}
              </div>
              <textarea
                value={rejectNote}
                onChange={(e) => setRejectNote(e.target.value)}
                placeholder={
                  rejectReason === 'other'
                    ? 'Tell us what was wrong (required)'
                    : 'Additional context (optional)'
                }
                className="mt-3 w-full resize-none rounded-md border border-zinc-200 px-2 py-1.5 text-sm placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none"
                rows={2}
              />
              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRejectOpen(false)}
                  className="rounded-full px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={submitReject}
                  disabled={!rejectReason || (rejectReason === 'other' && !rejectNote.trim())}
                  className="rounded-full bg-rose-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-rose-300"
                >
                  Reject
                </button>
              </div>
            </div>
          )}
        </div>
        <span className="ml-auto text-xs text-zinc-500">⏎ approve · ⌘⏎ in prompt to redraft</span>
      </div>
    </>
  )
}

// Sandbox-only settings modal. Persists to localStorage. Production would
// hydrate from + save to mailbox.persona.statistical_markers.appointment_url
// via the /api/persona PUT route.
function SettingsModal({
  settings,
  onSave,
  onClose,
}: {
  settings: OperatorSettings
  onSave: (next: OperatorSettings) => void
  onClose: () => void
}) {
  const [appointmentUrl, setAppointmentUrl] = useState(settings.appointmentUrl)
  const [calendarSrc, setCalendarSrc] = useState(settings.calendarSrc)
  const [driveFolderId, setDriveFolderId] = useState(settings.driveFolderId)

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  function commit() {
    onSave({
      ...settings,
      appointmentUrl: appointmentUrl.trim(),
      calendarSrc: calendarSrc.trim(),
      driveFolderId: driveFolderId.trim(),
    })
  }

  const dirty =
    settings.appointmentUrl !== appointmentUrl.trim() ||
    settings.calendarSrc !== calendarSrc.trim() ||
    settings.driveFolderId !== driveFolderId.trim()

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-zinc-900/40 px-4 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <Settings className="h-4 w-4 text-zinc-500" />
          <h2 className="text-base font-semibold text-zinc-900">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-full p-1 text-zinc-500 hover:bg-zinc-100"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-5 text-xs text-zinc-500">
          Sandbox settings — saved in this browser's localStorage. Production stores these in
          <code className="mx-1 rounded bg-zinc-100 px-1 py-0.5 text-[11px]">
            mailbox.persona.statistical_markers
          </code>
          .
        </p>

        <label className="block">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-800">Booking link</span>
            {appointmentUrl.trim() && (
              <a
                href={appointmentUrl.trim()}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700"
              >
                Open <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          <input
            type="url"
            placeholder="https://calendar.app.google/...  or  https://calendly.com/you"
            value={appointmentUrl}
            onChange={(e) => setAppointmentUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
            }}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
            autoFocus
          />
          <p className="mt-1.5 text-[11px] text-zinc-500">
            When set, the AI redraft system prompt includes:
            <span className="ml-1 italic text-zinc-600">
              "If the customer is asking to schedule a meeting, share this booking link verbatim."
            </span>{' '}
            Leave blank to disable. Google Calendar's built-in Appointment Schedules feature
            replaces Calendly natively — open Google Calendar → + Create → Appointment schedule
            to generate a public booking URL.
          </p>
        </label>

        <label className="mt-5 block">
          <span className="mb-1 block text-sm font-medium text-zinc-800">
            Calendar embed source
          </span>
          <input
            type="text"
            placeholder="you@gmail.com  or  abcdef@group.calendar.google.com  or  full embed URL"
            value={calendarSrc}
            onChange={(e) => setCalendarSrc(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
            }}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          <p className="mt-1.5 text-[11px] text-zinc-500">
            Powers the right-hand calendar pane. Paste your Google account email, a calendar
            ID, or a full <code className="rounded bg-zinc-100 px-1">calendar.google.com/calendar/embed</code>{' '}
            URL. Note: Google's main calendar app refuses to iframe (X-Frame-Options); this
            uses the public embed endpoint, which is read-mostly. Your calendar's sharing
            setting controls how much detail visitors see ("See all event details" vs "See
            only free/busy") — the embed honors that.
          </p>
        </label>

        <label className="mt-5 block">
          <span className="mb-1 block text-sm font-medium text-zinc-800">
            Drive folder ID
          </span>
          <input
            type="text"
            placeholder="0BwwA4oUTeiV1TGRPeTVjaWRDY1E  (or the full /drive/folders/ URL)"
            value={driveFolderId}
            onChange={(e) => setDriveFolderId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
            }}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100"
          />
          <p className="mt-1.5 text-[11px] text-zinc-500">
            Powers the Drive tab in the right pane. Open any folder in Drive and grab the
            chunk after <code className="rounded bg-zinc-100 px-1">/drive/folders/</code> in
            the URL. The embed uses{' '}
            <code className="rounded bg-zinc-100 px-1">drive.google.com/embeddedfolderview</code>{' '}
            (read-only, list view) — the main Drive app blocks iframing same as Calendar.
            Folder must be shared with whoever you want viewing it, OR you must be signed
            into the same Google account in this browser.
          </p>
        </label>

        <div className="mt-6 flex items-center justify-end gap-2">
          {dirty && <span className="mr-auto text-xs text-amber-700">Unsaved changes</span>}
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

export default App
