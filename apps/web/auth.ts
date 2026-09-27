import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { now, SESSION_MAX_AGE_HOURS, signInSchema } from '@pulse/core';
import { authenticate, type AuthenticateFailure } from '@pulse/core/server';
import { redactConnectionString } from '@pulse/db';

// Spec: SECURITY.md#sign-in-and-passwords and docs/adr/0004-password-only-auth-on-internal-network.md
// — Auth.js with the Credentials provider (email and password only) and JWT sessions.
//
// The JWT holds only the user id (`sub`) and when the user signed in (`signedInAt`, seconds since
// the epoch, set once). Everything else is reloaded from the database on every request
// (`loadSessionUser`), which also ends the session SESSION_MAX_AGE_HOURS after sign-in however
// often Auth.js re-issues the cookie.

declare module 'next-auth' {
  interface Session {
    /** Seconds since the epoch, set once at sign-in. */
    signedInAt?: number;
  }
}

/** A failed sign-in. `code` is one of {@link AuthenticateFailure}; the sign-in action maps it. */
class SignInFailed extends CredentialsSignin {
  constructor(code: AuthenticateFailure) {
    super();
    this.code = code;
  }
}

/** Whether `error` is a failed sign-in, and which kind. */
export function signInFailureCode(error: unknown): AuthenticateFailure | null {
  if (!(error instanceof CredentialsSignin)) return null;
  const code = error.code;
  return code === 'bad-domain' || code === 'inactive' ? code : 'invalid';
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (credentials) => {
        const parsed = signInSchema.safeParse(credentials);
        if (!parsed.success) throw new SignInFailed('invalid');
        const result = await authenticate(parsed.data);
        if (!result.ok) throw new SignInFailed(result.code);
        return { id: result.userId };
      },
    }),
  ],
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_HOURS * 60 * 60 },
  pages: { signIn: '/login' },
  callbacks: {
    jwt: ({ token, user }) => {
      // At sign-in: the id and the sign-in time only (no name, email or picture).
      if (user?.id) return { sub: user.id, signedInAt: Math.floor(now().getTime() / 1000) };
      return { sub: token.sub, signedInAt: token.signedInAt };
    },
    session: ({ session, token }) => ({
      expires: session.expires,
      user: { id: token.sub },
      signedInAt: typeof token.signedInAt === 'number' ? token.signedInAt : undefined,
    }),
  },
  // Never log request bodies (they hold the password) or expected sign-in failures.
  logger: {
    error: (error) => {
      if (error instanceof CredentialsSignin) return;
      // Auth.js wraps the underlying error as `cause.err`. Only its name and message are logged,
      // with any connection string redacted; the services never put a password in a message.
      const inner = (error.cause as { err?: unknown } | undefined)?.err;
      const detail =
        inner instanceof Error ? `: ${inner.name}: ${redactConnectionString(inner.message)}` : '';
      console.error(`[auth] ${error.name}${detail}`);
    },
    warn: (code) => console.warn(`[auth] warning: ${code}`),
    debug: () => {},
  },
});
