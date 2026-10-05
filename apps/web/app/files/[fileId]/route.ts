import {
  contentDisposition,
  findAccessibleFile,
  openStoredFile,
  registerCoreFileAccess,
  StoredFileMissingError,
} from '@pulse/core/server';
import { getCurrentUser } from '@/lib/auth';

// The one Route Handler that serves stored files (docs/ARCHITECTURE.md#file-storage). Nothing
// else links to the storage folder. The id is looked up in `storedFiles`; the path on disk comes
// only from that record's generated storage key, never from the request, so `../` and similar get
// nowhere. The viewer must be signed in and active (step 1.2), and the owner type's registered
// access check runs before any content is read (step 1.6). A refused file and a missing one get the
// same 404 "File not found.", so no answer reveals whether an id exists.

const NOT_FOUND = 'File not found.';

// Plain-text answers with no detail about the file.
function refuse(status: 401 | 404, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(
  request: Request,
  { params }: RouteContext<'/files/[fileId]'>,
): Promise<Response> {
  // Signed in first, before anything is looked up. A temporary password must be changed before any
  // file opens. The proxy already redirects both to a page (sign-in, or change password), so this
  // 401 isn't reached today; it stays as defence in depth, so the route doesn't rely on the proxy.
  const user = await getCurrentUser();
  if (!user || user.mustChangePassword) return refuse(401, 'Sign in to open this file.');

  // Core's owner types, registered explicitly (once per process; later calls do nothing).
  registerCoreFileAccess();

  // Missing and refused alike come back as null, and get the same answer.
  const { fileId } = await params;
  const file = await findAccessibleFile(user, fileId);
  if (!file) return refuse(404, NOT_FOUND);

  let content;
  try {
    content = await openStoredFile(file);
  } catch (error) {
    if (error instanceof StoredFileMissingError) return refuse(404, NOT_FOUND);
    throw error;
  }

  // Images may open in the page (`?inline=1`, for photos); everything else downloads.
  const inline =
    new URL(request.url).searchParams.get('inline') === '1' &&
    file.contentType.startsWith('image/');

  return new Response(content.stream, {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(content.sizeBytes),
      'Content-Disposition': contentDisposition(file, inline ? 'inline' : 'attachment'),
      'X-Content-Type-Options': 'nosniff',
      // Files belong to records someone was allowed to open: never keep them in shared caches.
      'Cache-Control': 'private, no-store',
      // A file never runs as a page: no scripts, no plugins, no framing.
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
