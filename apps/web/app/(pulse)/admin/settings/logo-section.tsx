'use client';

import { type ChangeEvent, startTransition, useActionState, useRef, useState } from 'react';
import { CircleAlert, ImageUp, Trash2 } from 'lucide-react';
import { fieldError } from '@pulse/core';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { FormSection } from '@pulse/ui/components/form';
import { CompanyLogo } from '@/components/company-logo';
import { removeCompanyLogoAction, setCompanyLogoAction } from '@/lib/actions/company-settings';
import { PlaceholderLabel, SavedNote, SectionHeading } from './settings-ui';

const ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * The company logo: a preview, Upload (or Replace) and Remove. Choosing a file uploads it at
 * once; Remove asks first. The sidebar and the login page show the logo through the public
 * `/company-logo` route, and the placeholder mark while there is none.
 */
export function LogoSection({
  logoUrl,
  uploadHint,
}: {
  logoUrl: string | null;
  uploadHint: string;
}) {
  const [result, upload, uploading] = useActionState(setCompanyLogoAction, null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removed, setRemoved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const uploadError =
    result && !result.ok ? (fieldError(result, 'logo') ?? result.formError) : null;

  function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    // Clear the input, so choosing the same file again still uploads it.
    event.currentTarget.value = '';
    if (!file) return;
    const formData = new FormData();
    formData.set('logo', file);
    setRemoved(false);
    startTransition(() => upload(formData));
  }

  async function remove() {
    setRemoveError(null);
    const outcome = await removeCompanyLogoAction(null, {});
    if (!outcome.ok) {
      setRemoveError(outcome.formError ?? 'The logo wasn’t removed. Try again.');
      // Keeps the dialog open with the error.
      throw new Error('Not removed');
    }
    setRemoved(true);
  }

  return (
    <section aria-labelledby="company-logo-title" className="flex flex-col gap-4">
      <SectionHeading id="company-logo-title" title="Logo">
        Shown on the login page, in the sidebar, and on payslips, HR documents and reports.
      </SectionHeading>
      <FormSection footer={uploadHint}>
        <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center">
          <div className="flex size-24 shrink-0 items-center justify-center rounded-card bg-bg-grouped p-3">
            <CompanyLogo
              logoUrl={logoUrl}
              className="size-full"
              placeholderClassName="text-footnote"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-subheadline font-medium">
              {logoUrl ? 'Company logo' : 'No logo yet'}
              {logoUrl ? null : <PlaceholderLabel />}
            </p>
            <p className="text-footnote text-text-secondary">
              {logoUrl
                ? 'Replace it with a new image, or remove it to show the placeholder mark.'
                : 'Screens show the placeholder mark until a logo is uploaded.'}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              ref={inputRef}
              type="file"
              name="logo"
              accept={ACCEPT}
              hidden
              tabIndex={-1}
              onChange={choose}
            />
            <Button variant="tinted" loading={uploading} onClick={() => inputRef.current?.click()}>
              <ImageUp aria-hidden="true" strokeWidth={1.75} />
              {logoUrl ? 'Replace logo' : 'Upload logo'}
            </Button>
            {logoUrl ? (
              <DestructiveConfirmDialog
                trigger={
                  <Button variant="secondary" className="text-destructive-text">
                    <Trash2 aria-hidden="true" strokeWidth={1.75} />
                    Remove logo
                  </Button>
                }
                onOpenChange={(open) => {
                  if (open) setRemoveError(null);
                }}
                title="Remove the company logo?"
                description="The login page, the sidebar and new documents will show the placeholder mark until you upload a logo again."
                confirmLabel="Remove logo"
                onConfirm={remove}
                error={removeError}
              />
            ) : null}
          </div>
        </div>
      </FormSection>
      {/* Always rendered, so a new error is announced as it appears. */}
      <div aria-live="polite" className="empty:hidden">
        {uploadError ? (
          <p className="flex items-start gap-1.5 px-4 text-footnote font-medium text-destructive-text">
            <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{uploadError}</span>
          </p>
        ) : null}
      </div>
      <div className="flex justify-end px-4 has-[[role=status]:empty]:hidden">
        <SavedNote show={(!!result?.ok && !uploading) || removed}>
          {removed ? 'Logo removed.' : 'Logo uploaded.'}
        </SavedNote>
      </div>
    </section>
  );
}
