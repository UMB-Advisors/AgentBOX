// STAQPRO-153 — pure extraction from sent_history rows → persona shape.
// On-appliance only (privacy: extraction never sees the cloud).
//
// Inputs are sent_history rows (or any superset thereof). Output is the
// canonical { statistical_markers, category_exemplars } pair ready to upsert.
//
// Heuristics, not ML. Phase 2 first cut. The point is to give the drafter
// SOMETHING grounded in real outbound voice. Refinement (per-counterparty
// adaptation, time-decay, etc.) is later work.

import type {
  CategoryExemplar,
  CategoryExemplars,
  PerCategoryMarkers,
  StatisticalMarkers,
} from './types';

export interface ExtractInput {
  draft_sent: string;
  classification_category: string;
  inbox_subject: string | null;
  inbox_body: string | null;
  sent_at: string;
}

export interface ExtractResult {
  statistical_markers: StatisticalMarkers;
  category_exemplars: CategoryExemplars;
  source_email_count: number;
}

const EXEMPLARS_PER_CATEGORY = 3;
const INBOUND_EXCERPT_CHARS = 500;
const COMMON_PHRASES_TOP_N = 10;
const TOP_N_SIGNOFFS_GREETINGS = 3;

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

const CASUAL_MARKERS = ['lol', 'lmk', 'thx', 'pls', 'gonna', 'wanna', 'kinda', 'fyi'];
const CONTRACTION_RE = /\b\w+'\w+\b/g;

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'is',
  'are',
  'was',
  'were',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'as',
  'by',
  'this',
  'that',
  'it',
  'its',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'them',
  'us',
  'me',
  'your',
  'our',
  'their',
  'my',
  'his',
  'her',
  'so',
  'just',
  'not',
  'no',
  'yes',
  'if',
  'then',
  'than',
  'from',
  'up',
  'out',
  'about',
  're',
  'can',
  'cant',
]);

export function extractPersona(rows: ExtractInput[]): ExtractResult {
  const stats: StatisticalMarkers = {
    source_email_count: rows.length,
    avg_sentence_words: 0,
    median_sentence_words: 0,
    formality_score: 0.5,
    sign_off_top: [],
    greeting_top: [],
    common_phrases: [],
    emoji_count: 0,
    per_category: {},
    extracted_at: new Date().toISOString(),
  };

  if (rows.length === 0) {
    return {
      statistical_markers: stats,
      category_exemplars: {},
      source_email_count: 0,
    };
  }

  const allSentenceLengths: number[] = [];
  const signoffCounter = new Map<string, number>();
  const greetingCounter = new Map<string, number>();
  const phraseCounter = new Map<string, number>();
  const perCategoryAccum = new Map<
    string,
    { sentenceLengths: number[]; casualHits: number; contractionHits: number; words: number }
  >();
  let totalWords = 0;
  let totalCasualHits = 0;
  let totalContractionHits = 0;
  let totalEmoji = 0;
  const exemplarsByCat = new Map<string, CategoryExemplar[]>();

  for (const row of rows) {
    const body = row.draft_sent;
    if (!body) continue;

    const sentences = splitSentences(body);
    for (const s of sentences) {
      const wc = wordCount(s);
      if (wc > 0) allSentenceLengths.push(wc);
    }

    const greeting = extractGreeting(body);
    if (greeting) {
      greetingCounter.set(greeting, (greetingCounter.get(greeting) ?? 0) + 1);
    }
    const signoff = extractSignoff(body);
    if (signoff) {
      signoffCounter.set(signoff, (signoffCounter.get(signoff) ?? 0) + 1);
    }

    for (const phrase of extractBigrams(body)) {
      phraseCounter.set(phrase, (phraseCounter.get(phrase) ?? 0) + 1);
    }

    const words = wordCount(body);
    totalWords += words;
    const casualHits = countCasualMarkers(body);
    totalCasualHits += casualHits;
    const contractionHits = (body.match(CONTRACTION_RE) ?? []).length;
    totalContractionHits += contractionHits;
    totalEmoji += (body.match(EMOJI_RE) ?? []).length;

    let cat = perCategoryAccum.get(row.classification_category);
    if (!cat) {
      cat = { sentenceLengths: [], casualHits: 0, contractionHits: 0, words: 0 };
      perCategoryAccum.set(row.classification_category, cat);
    }
    cat.sentenceLengths.push(...sentences.map(wordCount).filter((n) => n > 0));
    cat.casualHits += casualHits;
    cat.contractionHits += contractionHits;
    cat.words += words;

    // Exemplars: keep up to 3 most-recent per category.
    const list = exemplarsByCat.get(row.classification_category) ?? [];
    if (list.length < EXEMPLARS_PER_CATEGORY) {
      list.push({
        inbound_subject: row.inbox_subject,
        inbound_body_excerpt: (row.inbox_body ?? '').slice(0, INBOUND_EXCERPT_CHARS),
        sent_body: body,
        sent_at: row.sent_at,
      });
      exemplarsByCat.set(row.classification_category, list);
    }
  }

  stats.avg_sentence_words = avg(allSentenceLengths);
  stats.median_sentence_words = median(allSentenceLengths);
  stats.formality_score = formalityScore(totalCasualHits, totalContractionHits, totalWords);
  stats.sign_off_top = topN(signoffCounter, TOP_N_SIGNOFFS_GREETINGS);
  stats.greeting_top = topN(greetingCounter, TOP_N_SIGNOFFS_GREETINGS);
  stats.common_phrases = topN(phraseCounter, COMMON_PHRASES_TOP_N);
  stats.emoji_count = totalEmoji;

  for (const [cat, accum] of perCategoryAccum.entries()) {
    const marker: PerCategoryMarkers = {
      sample_size: exemplarsByCat.get(cat)?.length ?? 0,
      avg_sentence_words: avg(accum.sentenceLengths),
      formality_score: formalityScore(accum.casualHits, accum.contractionHits, accum.words),
    };
    (stats.per_category as Record<string, PerCategoryMarkers>)[cat] = marker;
  }

  const exemplars: CategoryExemplars = {};
  for (const [cat, list] of exemplarsByCat.entries()) {
    (exemplars as Record<string, CategoryExemplar[]>)[cat] = list;
  }

  return {
    statistical_markers: stats,
    category_exemplars: exemplars,
    source_email_count: rows.length,
  };
}

// ---------- helpers ----------

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function wordCount(text: string): number {
  return (text.match(/\b\w+\b/g) ?? []).length;
}

function avg(xs: number[]): number {
  if (xs.length === 0) return 0;
  const total = xs.reduce((a, b) => a + b, 0);
  return Math.round((total / xs.length) * 100) / 100;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function topN(counter: Map<string, number>, n: number): string[] {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

function countCasualMarkers(text: string): number {
  const lower = text.toLowerCase();
  let hits = 0;
  for (const marker of CASUAL_MARKERS) {
    const re = new RegExp(`\\b${marker}\\b`, 'g');
    hits += (lower.match(re) ?? []).length;
  }
  return hits;
}

// formality_score: 1 = formal, 0 = casual. Heuristic: penalize per-word
// contractions and casual markers. 0..1 clamped.
function formalityScore(casual: number, contractions: number, words: number): number {
  if (words === 0) return 0.5;
  const casualRate = casual / words;
  const contractionRate = contractions / words;
  // Each ~5% rate roughly halves the formality. Tunable.
  const penalty = Math.min(1, casualRate * 8 + contractionRate * 4);
  return Math.round((1 - penalty) * 100) / 100;
}

// First non-empty line, max 6 words. Captures "Hi Eric," or "Hello team —".
function extractGreeting(body: string): string | null {
  const firstLine = body.split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  const trimmed = firstLine.trim();
  const words = trimmed.split(/\s+/).slice(0, 6).join(' ');
  return words.replace(/[,.\-—]+$/, '').trim() || null;
}

// Last non-empty line, max 4 words. Captures "Best,", "Thanks!", "— Eric".
function extractSignoff(body: string): string | null {
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  const words = last.split(/\s+/).slice(0, 4).join(' ');
  return words.replace(/[,.\-—!]+$/, '').trim() || null;
}

// 2-word phrases of non-stop content words.
function extractBigrams(text: string): string[] {
  const tokens = (text.toLowerCase().match(/\b[a-z]+\b/g) ?? []).filter((t) => !STOP_WORDS.has(t));
  const bigrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bigrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bigrams;
}
