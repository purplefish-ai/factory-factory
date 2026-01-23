/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
  },
  // Point Next.js to the frontend directory
  pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
  distDir: '.next',
  // Configure to look in src/frontend for app directory
  webpack: (config) => {
    return config;
  },
};

export default nextConfig;
