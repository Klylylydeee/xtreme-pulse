import { handlers } from '@/auth';

// Auth.js endpoints (credentials callback, sign-out, session, CSRF). A sign-in here runs the same
// checks as the login form, because both go through the Credentials provider in auth.ts.
export const { GET, POST } = handlers;
