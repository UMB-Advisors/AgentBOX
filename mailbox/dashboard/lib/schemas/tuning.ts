import { z } from 'zod';
import { EMOJI_POLICIES, SENTENCE_LENGTHS } from '@/lib/tuning/style';

// MBOX-162 P5a — PUT /api/tuning/style body. The operator's voice knobs from
// the Tuning · Style tab. Each field is optional with a neutral default so a
// partial body is safe; the route merges the resulting marker keys into the
// existing persona.statistical_markers (preserving extraction-derived markers
// and category_exemplars). '' / [] are valid "clear this knob" values.

const sentenceLength = z.enum(['', ...SENTENCE_LENGTHS]).default('');
const emojiPolicy = z.enum(['', ...EMOJI_POLICIES]).default('');

export const styleProfileSchema = z.object({
  formality: z.number().min(0).max(100).default(50),
  sentence_length: sentenceLength,
  greeting: z.string().trim().max(200, 'greeting too long').default(''),
  closing: z.string().trim().max(500, 'closing too long').default(''),
  emoji_policy: emojiPolicy,
  jargon_allowlist: z
    .array(z.string().trim().max(80, 'jargon term too long'))
    .max(50, 'too many jargon terms')
    .default([]),
});

export type StyleProfileInput = z.infer<typeof styleProfileSchema>;
