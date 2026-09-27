import { AccessDeniedError } from '@pulse/core';
import {
  assertFileRouteOpen,
  authorizeFileAccess,
  contentDisposition,
  findStoredFile,
  openStoredFile,
  StoredFileMissingError,
} from '@pulse/core/server';

// The one Route Handler that serves stored files (docs/ARCHITECTURE.md#file-storage). Nothing
// else links to the storage folder. The id is looked up in `storedFiles`; the path on disk comes
// only from that record's generated storage key, never from the request, so `../` and similar get
// nowhere. The access check runs before any content is read (step 1.6 fills it in). Until then
// production refuses every request before any lookup, so no answer reveals whether an id exists.

// Plain-text answers with no detail about the file.
function refuse(status: 403 | 404 | 500, message: string): Response {
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
  try {
    // Before the lookup: until step 1.6, production answers every id with the same 403.
    assertFileRouteOpen();
  } catch (error) {
    if (error instanceof AccessDeniedError) return refuse(403, error.message);
    throw error;
  }

  const { fileId } = await params;
  const file = await findStoredFile(fileId);
  if (!file) return refuse(404, 'File not found.');

  try {
    await authorizeFileAccess(file);
  } catch (error) {
    if (error instanceof AccessDeniedError) return refuse(403, error.message);
    throw error;
  }

  let content;
  try {
    content = await openStoredFile(file);
  } catch (error) {
    if (error instanceof StoredFileMissingError) return refuse(404, 'File not found.');
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
