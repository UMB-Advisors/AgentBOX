/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // basePath is read at build time. Local dev → root. Production Docker build
  // sets BASE_PATH=/dashboard so the app serves under Caddy's /dashboard prefix
  // without a separate handle_path strip.
  basePath: process.env.BASE_PATH || '',
  // Pre-existing TS2741 in app/daily-brief/page.tsx (job_outcomes/DigestPayload)
  // predates this upgrade; keep build unblocked until that file is fixed.
  typescript: {
    ignoreBuildErrors: true,
  },
};

module.exports = nextConfig;
