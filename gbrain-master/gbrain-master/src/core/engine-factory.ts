import type { BrainEngine } from './engine.ts';
import type { EngineConfig } from './types.ts';

/**
 * Create an engine instance based on config.
 * Uses dynamic imports so PGLite WASM is never loaded for Postgres users.
 */
export async function createEngine(config: EngineConfig): Promise<BrainEngine> {
  const engineType = config.engine || 'postgres';

  switch (engineType) {
    case 'pglite': {
      const { PGLiteEngine } = await import('./pglite-engine.ts');
      return new PGLiteEngine();
    }
    case 'postgres': {
      const { PostgresEngine } = await import('./postgres-engine.ts');
      return new PostgresEngine();
    }
    case 'tridb': {
      // TriDB: PostgreSQL 13.4 fork with a native graph access method + pgvector (the -pgv image).
      // Extends the Postgres engine; overrides the graph leg to use the native adjacency store.
      const { TriDBEngine } = await import('./tridb-engine.ts');
      return new TriDBEngine();
    }
    default:
      throw new Error(
        `Unknown engine type: "${engineType}". Supported engines: postgres, pglite, tridb.` +
        (engineType === 'sqlite' ? ' SQLite is not supported. Use pglite instead.' : '')
      );
  }
}
