// dashboard/lib/drafting/redraft.ts
//
// P3 (MBOX-162) — assemble the chat messages for an operator "redraft with
// prompt" turn. Reuses assemblePrompt() so the rewrite carries the SAME persona
// system prompt + inbound context the original draft was written against, then
// frames the current draft as the assistant's prior turn and the operator's
// instruction as the next user turn. The local model continues the
// "conversation", rewriting the reply.
//
// Stateless: each redraft request carries the latest `current_body`, so
// iteration ("shorter" → "warmer") works without server-side history — the
// client always sends the most recent body.

import { assemblePrompt, type ChatMessage, type DraftPromptInput } from './prompt';

export interface RedraftInput {
  // Same fields assemblePrompt needs to rebuild the persona + inbound context.
  base: DraftPromptInput;
  // The operator's current in-progress draft body (what they want revised).
  current_body: string;
  // The refine instruction ("make it warmer", "shorter", "add a deadline").
  instruction: string;
}

export function assembleRedraftMessages(input: RedraftInput): ChatMessage[] {
  const { messages } = assemblePrompt(input.base);
  return [
    ...messages,
    // The draft the operator is iterating on, framed as the model's prior turn.
    { role: 'assistant', content: input.current_body },
    // The operator's refine instruction. Constrain the output to a bare reply
    // body so it drops straight into the inline editor on Apply.
    {
      role: 'user',
      content: `Revise your draft reply above based on this instruction:\n\n"${input.instruction}"\n\nReturn ONLY the revised reply body — no preamble, no surrounding quotes, no explanation.`,
    },
  ];
}
