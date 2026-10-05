import { registerFileAccess } from '../files/access';
import { COMPANY_LOGO_OWNER_TYPE, getCompanyLogoFile } from './service';

// Who may open company settings files through the file route (docs/ARCHITECTURE.md#file-storage,
// build step 1.6). The only one is the company logo, which every page header shows, so any
// signed-in, active user may open it; the route has checked both before this runs. Only the
// current logo opens: the file whose id equals `companySettings.logoFileId` (the same file
// `/company-logo` serves). A replaced or removed logo, or any other file owned by the settings
// record, is refused. Signed-out visitors see the logo only through `/company-logo`
// (SECURITY.md#exceptions-to-module-access).

/** Registers the company settings file access check. Called by `registerCoreFileAccess`. */
export function registerCompanySettingsFileAccess(): void {
  registerFileAccess(
    COMPANY_LOGO_OWNER_TYPE,
    async (_user, file) => (await getCompanyLogoFile())?.id === file.id,
  );
}
