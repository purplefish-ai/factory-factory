import { type NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  // Only proxy /api/* requests
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:3001';
    const url = new URL(request.nextUrl.pathname + request.nextUrl.search, backendUrl);

    return NextResponse.rewrite(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/api/:path*',
};
