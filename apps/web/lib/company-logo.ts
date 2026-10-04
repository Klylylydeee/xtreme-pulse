import { cache } from 'react';
import { connection } from 'next/server';
import { getCompanySettings } from '@pulse/core/server';

/**
 * The public company logo URL (`/company-logo?v=<fileId>`), or null while no logo is uploaded.
 * Only the URL leaves this function, so the public login page can call it without reading any
 * other company detail (SECURITY.md#exceptions-to-module-access). Read once per request.
 */
export const getCompanyLogoUrl = cache(async (): Promise<string | null> => {
  // Read per request, never at build time: the logo can change at any moment.
  await connection();
  try {
    return (await getCompanySettings()).logoUrl;
  } catch {
    // The logo is decoration: with no settings record (before the seed) or the database briefly
    // unreachable, the page still opens with the placeholder mark.
    return null;
  }
});
