import { NoAccessState } from '@/components/no-access-state';
import { ShellPageTitle } from '@/components/shell-page-title';
import { NO_ACCESS_PAGE_TITLE } from '@/lib/navigation';

/**
 * What a signed-in page shows when its guard refuses (`requireModulePage`, `requireAdminPage` call
 * `forbidden()`): HTTP 403 with the no-access state, inside the shell
 * (SECURITY.md#resolving-and-enforcing-build-step-16). The toolbar and tab read "No access".
 */
export default function PulseForbidden() {
  return (
    <>
      <ShellPageTitle title={NO_ACCESS_PAGE_TITLE} />
      <NoAccessState />
    </>
  );
}
