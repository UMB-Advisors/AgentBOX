import { PersonaSettings } from '@/components/PersonaSettings';
import { getPersona } from '@/lib/queries-persona';
import type { Persona } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function PersonaSettingsPage() {
  let initial: Persona | null = null;
  let error: string | null = null;

  try {
    initial = await getPersona();
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load persona';
  }

  if (error) {
    return (
      <main className="flex h-screen flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
          <h1 className="font-sans text-sm font-semibold tracking-tight">MailBox One</h1>
        </header>
        <div className="m-4 rounded-sm border border-accent-red/40 bg-accent-red/10 p-4 text-sm text-accent-red">
          <p className="mb-1 font-medium">Failed to load persona</p>
          <p className="font-mono text-xs">{error}</p>
        </div>
      </main>
    );
  }

  return <PersonaSettings initial={initial} />;
}
