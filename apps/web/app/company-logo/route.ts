import { getCompanyLogoFile, openStoredFile, StoredFileMissingError } from '@pulse/core/server';

// The one public stored file (SECURITY.md#exceptions-to-module-access,
// docs/ARCHITECTURE.md#file-storage): the login page shows the company logo before anyone signs
// in. It serves only the stored file whose id equals `companySettings.logoFileId`, and only a PNG,
// JPEG or WebP image (`getCompanyLogoFile`); anything else, including no logo, is "not found". No
// file id is taken from the request: `?v=<fileId>` is only a cache buster. When it names the
// current logo, the answer may be cached for good (a new logo has a new id, so a new URL);
// otherwise it is never cached, like the file route.

function notFound(): Response {
  return new Response('Not found.', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const file = await getCompanyLogoFile();
  if (!file) return notFound();

  let content;
  try {
    content = await openStoredFile(file);
  } catch (error) {
    if (error instanceof StoredFileMissingError) return notFound();
    throw error;
  }

  const version = new URL(request.url).searchParams.get('v');
  const cacheControl =
    version === file.id ? 'public, max-age=31536000, immutable' : 'private, no-store';

  return new Response(content.stream, {
    status: 200,
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(content.sizeBytes),
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': cacheControl,
      // An image never runs as a page: no scripts, no plugins, no framing.
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    },
  });
}
