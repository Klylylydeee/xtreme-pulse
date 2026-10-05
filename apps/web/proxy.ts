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

// Set for a minute next to a refused session cookie's deletion. Several requests can be in flight
// when a session is refused (two Server Actions from one click, or a navigation and its
// prefetches): the first clears the session cookie, so the rest arrive without it and would look
// like a visit from someone who never signed in. The flag keeps the "signed out" notice on their
// redirects too. It holds only `1`, so nothing about the user, and a valid session deletes it.
const SIGNED_OUT_COOKIE = 'pulse-signed-out';
const SIGNED_OUT_SECONDS = 60;

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
    // A session cookie that no longer passes, or one refused a moment ago (the flag), means the
    // user was signed out, not just new here.
    const refused = sessionCookies.length > 0;
    if (refused || request.cookies.has(SIGNED_OUT_COOKIE)) {
      login.searchParams.set('reason', 'signed-out');
    }
    const response = NextResponse.redirect(login);
    if (refused) {
      response.cookies.set(SIGNED_OUT_COOKIE, '1', {
        path: '/',
        maxAge: SIGNED_OUT_SECONDS,
        httpOnly: true,
        sameSite: 'lax',
        // Secure exactly when the refused session cookie was (`__Secure-`, over HTTPS).
        secure,
      });
    }
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

  const response =
    user.mustChangePassword && pathname !== '/change-password'
      ? NextResponse.redirect(new URL(changePasswordPath(`${pathname}${search}`), request.url))
      : NextResponse.next();
  // Signed in again: a later sign-out shouldn't inherit the old notice.
  if (request.cookies.has(SIGNED_OUT_COOKIE)) response.cookies.delete(SIGNED_OUT_COOKIE);
  return response;
}

export const config = {
  // Everything except Next's own files (build output, images, dev reload) and static assets. The
  // public pages are handled above.
  matcher: [
    '/((?!_next/|favicon\\.ico|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|webmanifest|woff2?)$).*)',
  ],
};
