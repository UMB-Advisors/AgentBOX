import { describe, expect, it } from 'vitest';
import type { Category } from '@/lib/classification/prompt';
import type { PersonaContext } from '@/lib/drafting/persona';
import { assemblePrompt, type DraftPromptInput } from '@/lib/drafting/prompt';

// Diff-based learning loop — the editLessonsBlock renders the contrastive
// original→sent pair into the USER prompt when edit_lessons is non-empty, and
// is byte-absent (graceful degrade) when empty. Distinct from exemplar_refs.

const PERSONA: PersonaContext = {
  tone: 'concise, direct',
  signoff: 'Best,\nDustin',
  operator_first_name: 'Dustin',
  operator_brand: 'Heron Labs',
  business_description: 'small-batch CPG operator',
};

function inputWith(edit_lessons?: DraftPromptInput['edit_lessons']): DraftPromptInput {
  return {
    from_addr: 'lead@example.com',
    to_addr: 'ops@heronlabs.com',
    subject: 'Re: pricing',
    body_text: 'What does a pallet cost?',
    category: 'inquiry' as Category,
    confidence: 0.9,
    persona: PERSONA,
    edit_lessons,
  };
}

function userContent(edit_lessons?: DraftPromptInput['edit_lessons']): string {
  const { messages } = assemblePrompt(inputWith(edit_lessons));
  return messages.find((m) => m.role === 'user')?.content ?? '';
}

describe('assemblePrompt — edit-lessons block', () => {
  it('injects the contrastive original→sent pair when present', () => {
    const content = userContent([
      {
        original: 'Hi there! Thanks so much for reaching out!! Pricing is $100.',
        final: 'Hi — a pallet is $100. Best, Dustin',
        sent_at: '2026-06-20T10:00:00Z',
        subject: 'Re: pricing',
      },
    ]);
    expect(content).toContain('How you revise drafts like this');
    expect(content).toContain('Assistant drafted:');
    expect(content).toContain('Thanks so much for reaching out');
    expect(content).toContain('Operator sent instead:');
    expect(content).toContain('a pallet is $100');
  });

  it('renders nothing when edit_lessons is empty or undefined', () => {
    expect(userContent([])).not.toContain('How you revise drafts like this');
    expect(userContent(undefined)).not.toContain('How you revise drafts like this');
  });

  it('caps to one lesson and truncates each side', () => {
    const long = 'x'.repeat(900);
    const content = userContent([
      { original: `AAA${long}`, final: `BBB${long}`, sent_at: '2026-06-20T10:00:00Z' },
      {
        original: 'second-lesson-original',
        final: 'second-lesson-final',
        sent_at: '2026-06-19T10:00:00Z',
      },
    ]);
    // Only the first lesson is rendered.
    expect(content).not.toContain('second-lesson-original');
    // Each side truncated to 400 chars → the 900-char tail can't appear in full.
    expect(content).not.toContain(`AAA${long}`);
    expect(content).toContain('AAA');
  });
});
