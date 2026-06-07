import { ClassificationsClient } from '@/components/ClassificationsClient';
import { type ClassificationRow, listClassifications } from '@/lib/queries-classifications';

export const dynamic = 'force-dynamic';

export default async function ClassificationsPage() {
  let initialRows: ClassificationRow[] = [];
  let error: string | null = null;

  try {
    initialRows = await listClassifications({ limit: 100 });
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load classifications';
  }

  if (error) {
    return (
      <main className="flex h-screen flex-col">
        <header className="flex h-12 shrink-0 items-center border-b border-border-subtle bg-bg-panel px-4">
          <h1 className="font-sans text-sm font-semibold tracking-tight">MailBox One</h1>
        </header>
        <div className="m-4 rounded-sm border border-accent-red/40 bg-accent-red/10 p-4 text-sm text-accent-red">
          <p className="mb-1 font-medium">Failed to load classifications</p>
          <p className="font-mono text-xs">{error}</p>
        </div>
      </main>
    );
  }

  return <ClassificationsClient initialRows={initialRows} />;
}
