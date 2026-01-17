import { type NextRequest } from 'next/server';
import { updateSession } from '@/lib/auth/middleware';

export async function middleware(request: NextRequest) {
    // Update session and get user
    const { response, user } = await updateSession(request);

    // Protected routes - require authentication
    // Includes all Kilat agent pages + user account pages
    const protectedRoutes = [
        // User account pages
        '/dashboard', '/agents', '/profile', '/billing', '/history', '/settings',
        // All 12 Kilat agent pages (MUST be protected!)
        '/kilatcode', '/kilatdesign', '/kilatimage', '/kilataudit', '/kilatdocs',
        '/kilatresearch', '/kilatwrite', '/kilatsolve', '/kilatquestion',
        '/kilatguide', '/kilatidea', '/kilatcrawl',
        // Main chat
        '/chat'
    ];
    const adminRoutes = ['/admin'];
    const publicOnlyRoutes = ['/login', '/signup', '/auth/login'];

    const { pathname } = request.nextUrl;

    // Check if route needs protection
    const isProtectedRoute = protectedRoutes.some(route => pathname.startsWith(route));
    const isAdminRoute = adminRoutes.some(route => pathname.startsWith(route));
    const isPublicOnlyRoute = publicOnlyRoutes.some(route => pathname.startsWith(route));

    // Redirect logic - Use actual user from Supabase, not just cookie
    if (isProtectedRoute || isAdminRoute) {
        if (!user) {
            // Not authenticated, redirect to login
            const url = request.nextUrl.clone();
            url.pathname = '/login';
            url.searchParams.set('redirect', pathname);
            return Response.redirect(url);
        }
    }

    if (isPublicOnlyRoute && user) {
        // Already authenticated, redirect to chat
        const url = request.nextUrl.clone();
        url.pathname = '/chat';
        return Response.redirect(url);
    }

    // CRITICAL: Add COOP/COEP headers for WebContainer routes
    // Reference: https://webcontainer.io - requires Cross-Origin Isolation
    // These headers MUST be set in middleware because middleware response overrides next.config.js headers
    if (pathname.startsWith('/kilatcode')) {
        response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    }

    return response;
}

export const config = {
    matcher: [
        /*
         * Match all request paths except:
         * - _next/static (static files)
         * - _next/image (image optimization files)
         * - favicon.ico (favicon file)
         * - public folder
         */
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
};
