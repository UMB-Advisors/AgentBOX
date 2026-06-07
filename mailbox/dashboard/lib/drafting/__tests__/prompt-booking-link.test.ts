import { describe, expect, it } from 'vitest';
import type { Category } from '@/lib/classification/prompt';
import type { PersonaContext } from '@/lib/drafting/persona';
import {
  assemblePrompt,
  bookingLinkSystemBlock,
  type DraftPromptInput,
} from '@/lib/drafting/prompt';

// MBOX-162 P4 follow-up — booking_link (operator_settings) injected into the
// per-operator system prompt when set, and omitted (byte-identical to before)
// when unset. Covers both the initial draft and, by reuse of assemblePrompt,
// the redraft loop.

const PERSONA: PersonaContext = {
  tone: 'concise, direct',
  signoff: 'Best,\nDustin',
  operator_first_name: 'Dustin',
  operator_brand: 'Heron Labs',
  business_description: 'small-batch CPG operator',
};

function inputWith(booking_link?: string): DraftPromptInput {
  return {
    from_addr: 'lead@example.com',
    to_addr: 'ops@heronlabs.com',
    subject: 'Can we set up a call?',
    body_text: 'Do you have time for a quick demo next week?',
    category: 'scheduling' as Category,
    confidence: 0.9,
    persona: PERSONA,
    booking_link,
  };
}

function systemContent(booking_link?: string): string {
  const { messages } = assemblePrompt(inputWith(booking_link));
  const sys = messages.find((m) => m.role === 'system');
  return sys?.content ?? '';
}

describe('bookingLinkSystemBlock', () => {
  it('returns the instruction with the URL verbatim when set', () => {
    const block = bookingLinkSystemBlock('https://calendly.com/dustin/intro');
    expect(block).toContain('SCHEDULING LINK');
    expect(block).toContain('https://calendly.com/dustin/intro');
  });

  it('returns empty string for undefined / empty / whitespace', () => {
    expect(bookingLinkSystemBlock(undefined)).toBe('');
    expect(bookingLinkSystemBlock('')).toBe('');
    expect(bookingLinkSystemBlock('   ')).toBe('');
  });

  it('trims surrounding whitespace off the URL', () => {
    expect(bookingLinkSystemBlock('  https://x.co/b  ')).toContain('https://x.co/b');
    expect(bookingLinkSystemBlock('  https://x.co/b  ')).not.toContain('  https://x.co/b');
  });
});

describe('assemblePrompt — booking_link injection', () => {
  it('injects the scheduling-link instruction into the system prompt when set', () => {
    const content = systemContent('https://calendly.com/dustin/intro');
    expect(content).toContain('SCHEDULING LINK');
    expect(content).toContain('https://calendly.com/dustin/intro');
  });

  it('omits the block entirely when booking_link is unset', () => {
    expect(systemContent(undefined)).not.toContain('SCHEDULING LINK');
    expect(systemContent('')).not.toContain('SCHEDULING LINK');
  });

  it('keeps the booking link out of the user prompt (system-only)', () => {
    const { messages } = assemblePrompt(inputWith('https://calendly.com/dustin/intro'));
    const user = messages.find((m) => m.role === 'user');
    expect(user?.content ?? '').not.toContain('calendly.com');
  });
});
