import type { Metadata } from 'next';
import { COMPANY_DETAIL_FIELDS, formatDate, pendingCompanyDetails } from '@pulse/core';
import {
  COMPANY_LOGO_TYPES,
  CompanySettingsMissingError,
  type CompanySettingsView,
  getCompanySettings,
  getFileUploadSettingsInfo,
  listAllowedEmailDomains,
  UPLOAD_TYPES,
  type UploadType,
} from '@pulse/core/server';
import { ErrorState } from '@pulse/ui/components/error-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { requireSystemAdministrator } from '@/lib/auth';
import { AllowedDomainsSection } from './allowed-domains-section';
import { CompanyDetailsForm, type CompanyDetailValues } from './company-details-form';
import { FileUploadsForm } from './file-uploads-form';
import { LogoSection } from './logo-section';

export const metadata: Metadata = { title: 'Company settings' };

const BYTES_PER_MEGABYTE = 1024 * 1024;

const TITLE = 'Company settings';
const DESCRIPTION =
  'The company details documents print, the logo, who can sign in, and the upload limits.';

function detailValues(settings: CompanySettingsView): CompanyDetailValues {
  return {
    registeredName: settings.registeredName,
    businessAddress: settings.businessAddress,
    tin: settings.tin,
    rdoCode: settings.rdoCode,
    sssEmployerNumber: settings.sssEmployerNumber,
    philhealthEmployerNumber: settings.philhealthEmployerNumber,
    pagibigEmployerId: settings.pagibigEmployerId,
    'birRegistration.casPermitDetails': settings.birRegistration.casPermitDetails,
    'birRegistration.invoiceSeries': settings.birRegistration.invoiceSeries,
  };
}

/** "PNG", "PNG or JPEG", "PNG, JPEG or WebP". */
function listOfTypes(types: readonly UploadType[]): string {
  const names = types.map((type) => UPLOAD_TYPES[type].label.replace(/ image$/, ''));
  const last = names.pop();
  return names.length > 0 ? `${names.join(', ')} or ${last}` : (last ?? '');
}

/**
 * The hint under the logo upload. A logo must be one of the logo types and also allowed by the
 * current upload settings (the upload checks both), so it names only the types in both.
 */
function logoUploadHint(allowedTypes: readonly UploadType[], maxMegabytes: number): string {
  const types = COMPANY_LOGO_TYPES.filter((type) => allowedTypes.includes(type));
  if (types.length === 0) {
    return 'The upload settings below allow no image type, so a logo can’t be uploaded. Allow PNG, JPEG or WebP there first.';
  }
  return `${listOfTypes(types)}, up to ${maxMegabytes} MB. A square image fits best.`;
}

// Spec: docs/modules/core.md#company-settings-page — the company details, the logo, the allowed
// email domains and the upload limits, on one page of inset grouped sections. The System
// Administrator only until module access arrives in step 1.6; anyone else gets "not found". The
// reads below don't check the role themselves, so this guard must stay first.
export default async function CompanySettingsPage() {
  const user = await requireSystemAdministrator();

  let settings: CompanySettingsView;
  try {
    settings = await getCompanySettings();
  } catch (error) {
    if (!(error instanceof CompanySettingsMissingError)) throw error;
    return (
      <>
        <PageHeader title={TITLE} description={DESCRIPTION} />
        <ErrorState
          title="Company settings haven’t been set up"
          description="The company settings record is missing. Ask whoever set up Pulse to run the seed (pnpm seed:admin), then reload this page."
        />
      </>
    );
  }
  const [domains, uploads] = await Promise.all([
    listAllowedEmailDomains(user),
    getFileUploadSettingsInfo(),
  ]);

  const pending = new Set(pendingCompanyDetails(settings).map((detail) => detail.path));
  const maxMegabytes = Math.floor(uploads.settings.maxSizeBytes / BYTES_PER_MEGABYTE);

  return (
    <>
      <PageHeader title={TITLE} description={DESCRIPTION} />
      <div className="flex max-w-3xl flex-col gap-10">
        <CompanyDetailsForm
          // A new save remounts the fields with the saved values.
          version={settings.updatedAt.toISOString()}
          values={detailValues(settings)}
          pending={COMPANY_DETAIL_FIELDS.filter((field) => pending.has(field.path)).map(
            (field) => field.path,
          )}
        />
        <LogoSection
          logoUrl={settings.logoUrl}
          uploadHint={logoUploadHint(uploads.settings.allowedTypes, maxMegabytes)}
        />
        <AllowedDomainsSection
          domains={domains.map(({ id, domain, userCount }) => ({ id, domain, userCount }))}
          ownDomain={user.email.split('@').pop() ?? ''}
        />
        <FileUploadsForm
          maxSizeMegabytes={maxMegabytes}
          allowedTypes={uploads.settings.allowedTypes}
          effectiveFrom={uploads.effectiveFrom ? formatDate(uploads.effectiveFrom) : null}
          changedToday={uploads.changedToday}
        />
      </div>
    </>
  );
}
