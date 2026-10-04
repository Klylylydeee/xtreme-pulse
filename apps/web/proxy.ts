import { NextResponse, type NextRequest } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { loadSessionUser } from '@pulse/core/server';
import { changePasswordPath, safeCallbackUrl } from '@/lib/callback-url';

// Spec: SECURITY.md#account-status — the status check on every request. JWT sessions can't be
// revoked on their own, so each request reloads the account (`loadSessionUser`): a deactivated
// user, or a session past SESSION_MAX_AGE_HOURS, is signed out at once. A user with a temporary
// password can open only the change-password page (SECURITY.md#sign-in-and-passwords).
//
// This is the first check, not the only one: the signed-in layout, the file route and every
// Server Action check the user again (apps/web/lib/auth.ts). Next 16 runs the proxy on Node.js.

// Open without signing in: the login page, Auth.js's own endpoints, the company logo (the one
// public stored file, SECURITY.md#exceptions-to-module-access) and the development-only pages
// (never served in production, see SECURITY.md#development-only-pages).
const PUBLIC_PATHS = ['/login', '/api/auth', '/company-logo', '/dev'];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

// Auth.js's session cookie: `__Secure-` over HTTPS, split into `.0`, `.1`, … when large.
const SESSION_COOKIE = /^(__Secure-)?authjs\.session-token(\.\d+)?$/;
const SESSION_COOKIE_NAME = 'authjs.session-token';

async function currentUserFor(request: NextRequest, secure: boolean) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;
  const cookieName = secure ? `__Secure-${SESSION_COOKIE_NAME}` : SESSION_COOKIE_NAME;
  const token = await getToken({
    req: request,
    secret,
    secureCookie: secure,
    cookieName,
    salt: cookieName,
  });
  if (typeof token?.sub !== 'string' || typeof token.signedInAt !== 'number') return null;
  return loadSessionUser(token.sub, token.signedInAt);
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const sessionCookies = request.cookies
    .getAll()
    .map((cookie) => cookie.name)
    .filter((name) => SESSION_COOKIE.test(name));
  const secure = sessionCookies.some((name) => name.startsWith('__Secure-'));
  const user = sessionCookies.length > 0 ? await currentUserFor(request, secure) : null;

  if (!user) {
    const login = new URL('/login', request.url);
    const callbackUrl = safeCallbackUrl(`${pathname}${search}`);
    if (callbackUrl !== '/') login.searchParams.set('callbackUrl', callbackUrl);
    // A session cookie that no longer passes means the user was signed out, not just new here.
    if (sessionCookies.length > 0) login.searchParams.set('reason', 'signed-out');
    const response = NextResponse.redirect(login);
    for (const name of sessionCookies) {
      response.cookies.set(name, '', {
        path: '/',
        maxAge: 0,
        httpOnly: true,
        sameSite: 'lax',
        // Browsers ignore a `__Secure-` cookie, even a deletion, without the Secure flag.
        secure: name.startsWith('__Secure-'),
      });
    }
    return response;
  }

  if (user.mustChangePassword && pathname !== '/change-password') {
    return NextResponse.redirect(new URL(changePasswordPath(`${pathname}${search}`), request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Everything except Next's own files (build output, images, dev reload) and static assets. The
  // public pages are handled above.
  matcher: [
    '/((?!_next/|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|webmanifest|woff2?)$).*)',
  ],
};
