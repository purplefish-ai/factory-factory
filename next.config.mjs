/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Point Next.js to the frontend directory
  pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
  distDir: '.next',
  // Enable standalone output for production deployments
  // This creates a self-contained build in .next/standalone
  output: 'standalone',
  // Enable Turbopack (default in Next.js 16)
  turbopack: {},
  // API proxying is handled by middleware.ts for runtime flexibility
};

export default nextConfig;
