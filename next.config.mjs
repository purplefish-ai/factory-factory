/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
  // Point Next.js to the frontend directory
  pageExtensions: ['tsx', 'ts', 'jsx', 'js'],
  distDir: '.next',
  // Enable Turbopack (default in Next.js 16)
  turbopack: {},
  // Proxy API requests to backend server
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
