/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // basePath is read at build time. Local dev → root. Production Docker build
  // sets BASE_PATH=/dashboard so the app serves under Caddy's /dashboard prefix
  // without a separate handle_path strip.
  basePath: process.env.BASE_PATH || '',
};

module.exports = nextConfig;
