'use client';

import { type FormEvent, startTransition, useActionState } from 'react';
import { CalendarClock, CircleAlert } from 'lucide-react';
import { fieldError, UPLOAD_SIZE_MAX_MEGABYTES, UPLOAD_TYPES, type UploadType } from '@pulse/core';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input } from '@pulse/ui/components/form';
import { FormAlert } from '@/components/form-alert';
import { updateFileUploadSettingsAction } from '@/lib/actions/company-settings';
import { SavedNote, SectionHeading } from './settings-ui';

const TYPE_ENTRIES = Object.entries(UPLOAD_TYPES) as [
  UploadType,
  (typeof UPLOAD_TYPES)[UploadType],
][];

/**
 * The upload limits (the `core.fileUploads` setting): the largest upload in whole MB and the
 * allowed file types. Saving adds a new version that takes effect today (Manila), never an edit;
 * only one change can take effect per day, so once today's change is saved the form is locked
 * until tomorrow (the service refuses a second change as well).
 */
export function FileUploadsForm({
  maxSizeMegabytes,
  allowedTypes,
  effectiveFrom,
  changedToday,
}: {
  maxSizeMegabytes: number;
  allowedTypes: UploadType[];
  /** The formatted day the settings in effect started, or null while the defaults apply. */
  effectiveFrom: string | null;
  changedToday: boolean;
}) {
  const [result, action, saving] = useActionState(updateFileUploadSettingsAction, null);
  const locked = changedToday && !saving;
  const typesError = fieldError(result, 'allowedTypes');

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    // Submitted by hand, not through the form's `action`, so a refused change keeps its values.
    startTransition(() => action(formData));
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-labelledby="file-uploads-title"
      className="flex flex-col gap-4"
    >
      <SectionHeading id="file-uploads-title" title="File uploads">
        The largest file people can upload, and which types, everywhere in Pulse.
      </SectionHeading>
      <div className="flex items-start gap-3 rounded-card bg-bg-grouped px-4 py-3.5">
        <CalendarClock
          aria-hidden="true"
          strokeWidth={1.75}
          className="mt-0.5 size-4.5 shrink-0 text-accent"
        />
        <p className="text-footnote text-text-secondary">
          {effectiveFrom
            ? `These limits have been in effect since ${effectiveFrom}.`
            : 'The default limits apply: no change has been saved yet.'}{' '}
          {changedToday
            ? 'They were changed today, and only one change can take effect per day: you can change them again tomorrow.'
            : 'Saving adds a new version that takes effect today. Only one change can take effect per day.'}
        </p>
      </div>
      <FormAlert message={result && !result.ok ? result.formError : null} />
      <fieldset disabled={locked} className="flex min-w-0 flex-col gap-6">
        <FormSection>
          <FormField
            label="Maximum upload size (MB)"
            hint={`A whole number from 1 to ${UPLOAD_SIZE_MAX_MEGABYTES}.`}
            error={fieldError(result, 'maxSizeMegabytes')}
            required
          >
            <Input
              type="number"
              name="maxSizeMegabytes"
              inputMode="numeric"
              min={1}
              max={UPLOAD_SIZE_MAX_MEGABYTES}
              step={1}
              defaultValue={maxSizeMegabytes}
              className="tabular-nums sm:max-w-40"
              required
            />
          </FormField>
        </FormSection>
        <FormSection
          title="Allowed file types"
          footer="Each file is checked by its content, not its name."
        >
          <fieldset
            aria-describedby={typesError ? 'allowed-types-error' : undefined}
            aria-invalid={typesError ? true : undefined}
            className="flex min-w-0 flex-col divide-y divide-separator"
          >
            <legend className="sr-only">Allowed file types</legend>
            {TYPE_ENTRIES.map(([type, { label, extension }]) => (
              <label
                key={type}
                className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-2 has-disabled:cursor-not-allowed"
              >
                <input
                  type="checkbox"
                  name="allowedTypes"
                  value={type}
                  defaultChecked={allowedTypes.includes(type)}
                  className="size-5 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body md:text-subheadline">{label}</span>
                  <span className="text-footnote text-text-secondary">.{extension}</span>
                </span>
              </label>
            ))}
          </fieldset>
        </FormSection>
        <div aria-live="polite" className="-mt-4 empty:hidden">
          {typesError ? (
            <p
              id="allowed-types-error"
              className="flex items-start gap-1.5 px-4 text-footnote font-medium text-destructive-text"
            >
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{typesError}</span>
            </p>
          ) : null}
        </div>
      </fieldset>
      <div className="flex flex-col-reverse items-stretch gap-3 px-4 sm:flex-row sm:items-center sm:justify-end">
        <SavedNote show={!!result?.ok && !saving}>
          Saved. The new limits take effect today.
        </SavedNote>
        <Button type="submit" loading={saving} disabled={locked}>
          Save upload limits
        </Button>
      </div>
    </form>
  );
}
