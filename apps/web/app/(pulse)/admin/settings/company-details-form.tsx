'use client';

import { type FormEvent, startTransition, useActionState } from 'react';
import { COMPANY_DETAIL_FIELDS, COMPANY_DETAIL_MAX_LENGTH, fieldError } from '@pulse/core';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input, Textarea } from '@pulse/ui/components/form';
import { FormAlert } from '@/components/form-alert';
import { updateCompanyDetailsAction } from '@/lib/actions/company-settings';
import { PlaceholderLabel, SavedNote, SectionHeading } from './settings-ui';

type DetailPath = (typeof COMPANY_DETAIL_FIELDS)[number]['path'];

/** The saved details, keyed by the field's dotted path (also its form field name). */
export type CompanyDetailValues = Record<DetailPath, string>;

/** Fields with longer text get a multi-line box. */
const MULTILINE: ReadonlySet<DetailPath> = new Set([
  'businessAddress',
  'birRegistration.casPermitDetails',
]);

const BIR_FIELDS: ReadonlySet<DetailPath> = new Set([
  'birRegistration.casPermitDetails',
  'birRegistration.invoiceSeries',
]);

/**
 * The company details on two inset sections (company and government numbers, then BIR
 * registration). A detail still holding its placeholder is labeled "Placeholder"; it may be saved
 * as is and stays pending. The form is submitted by hand, not through `action`, so a failed save
 * keeps what was typed (React resets a form after its action runs).
 */
export function CompanyDetailsForm({
  version,
  values,
  pending,
}: {
  /** Changes with every save, so the fields remount with the saved values. */
  version: string;
  values: CompanyDetailValues;
  /** The paths of the details still pending. */
  pending: DetailPath[];
}) {
  const [result, action, saving] = useActionState(updateCompanyDetailsAction, null);
  const pendingSet = new Set(pending);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => action(formData));
  }

  function field({ path, label }: { path: DetailPath; label: string }) {
    const Control = MULTILINE.has(path) ? Textarea : Input;
    return (
      <FormField
        key={path}
        label={
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
            {label}
            {pendingSet.has(path) ? <PlaceholderLabel /> : null}
          </span>
        }
        error={fieldError(result, path)}
        required
      >
        <Control
          name={path}
          defaultValue={values[path]}
          maxLength={COMPANY_DETAIL_MAX_LENGTH}
          autoComplete="off"
          spellCheck={false}
          required
          {...(MULTILINE.has(path) ? { rows: 2 } : {})}
        />
      </FormField>
    );
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-labelledby="company-details-title"
      className="flex flex-col gap-4"
    >
      <SectionHeading id="company-details-title" title="Company details">
        Payslips, HR documents and reports print these. Replace each placeholder once the company
        has the detail.
      </SectionHeading>
      <FormAlert message={result && !result.ok ? result.formError : null} />
      <div key={version} className="flex flex-col gap-6">
        <FormSection title="Company">
          {COMPANY_DETAIL_FIELDS.filter((detail) => !BIR_FIELDS.has(detail.path)).map(field)}
        </FormSection>
        <FormSection
          title="BIR registration"
          footer="As printed on the BIR acknowledgment or permit, and the registered invoice series."
        >
          {COMPANY_DETAIL_FIELDS.filter((detail) => BIR_FIELDS.has(detail.path)).map(field)}
        </FormSection>
      </div>
      <div className="flex flex-col-reverse items-stretch gap-3 px-4 sm:flex-row sm:items-center sm:justify-end">
        <SavedNote show={!!result?.ok && !saving}>Company details saved.</SavedNote>
        <Button type="submit" loading={saving}>
          Save details
        </Button>
      </div>
    </form>
  );
}
