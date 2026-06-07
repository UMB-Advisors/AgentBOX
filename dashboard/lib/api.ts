// Client-side fetches must include the Next.js basePath. The dashboard is
// served at /dashboard in production (BASE_PATH=/dashboard baked into the
// build); a bare `fetch('/api/...')` from the browser hits Caddy at the root
// and falls through to the n8n catch-all → 404. NEXT_PUBLIC_BASE_PATH is
// inlined into the client bundle at build time.

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export function apiUrl(path: string): string {
  return `${BASE_PATH}${path}`;
}
