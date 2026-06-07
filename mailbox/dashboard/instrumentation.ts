// dashboard/instrumentation.ts
//
// Next.js 14 instrumentation hook. Runs ONCE on cold boot of the Node
// runtime (not the Edge runtime, not during `next build`). We use it to
// schedule the in-process classify sweeper that auto-recovers from a
// MailBOX-Classify outage. See lib/jobs/classify-sweeper.ts for the why.
//
// Requires `experimental.instrumentationHook: true` in next.config.js.
//
// IMPORTANT: the dynamic import MUST live inside the `=== 'nodejs'`
// positive branch (not an early-return guard) so webpack tree-shakes
// it from the edge bundle. Otherwise the edge build pulls `pg` and
// fails on missing Node builtins (`fs`, `path`, `stream`). This is the
// canonical Next.js docs pattern for runtime-scoped imports — see
// https://nextjs.org/docs/app/api-reference/file-conventions/instrumentation#importing-files-with-side-effects

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (process.env.NEXT_PHASE === 'phase-production-build') return;
    const { startClassifySweeper } = await import('./lib/jobs/classify-sweeper');
    startClassifySweeper();
    const { startGmailRatelimitSweeper } = await import('./lib/jobs/gmail-ratelimit-sweeper');
    startGmailRatelimitSweeper();
    const { startStuckStubSweeper } = await import('./lib/jobs/stuck-stub-sweeper');
    startStuckStubSweeper();
  }
}
