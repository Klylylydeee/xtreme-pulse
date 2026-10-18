'use client';

import { type ReactNode, useRef, useState } from 'react';
import { CircleAlert, RotateCw } from 'lucide-react';
import { businessToday, type FieldErrors, formatDate } from '@pulse/core';
import {
  ARCHIVE_REASON_MAX_LENGTH,
  CERTIFICATION_ISSUER_MAX_LENGTH,
  CERTIFICATION_NAME_MAX_LENGTH,
  type CertificationView,
  DOCUMENT_201_TYPE_LABELS,
  DOCUMENT_201_TYPES,
  DOCUMENT_TITLE_MAX_LENGTH,
  type Document201Type,
  type EmployeeDocumentView,
  type EmployeeRecordView,
  EXPIRY_LEAD_DAYS_MAX,
  EXPIRY_LEAD_DAYS_MIN,
  type ExpiryAlertSettingsView,
  LICENSE_NUMBER_MAX_LENGTH,
  SKILL_MAX_LENGTH,
  SKILLS_MAX_COUNT,
  STALE_FORM_MESSAGES,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input, Select, Switch, Textarea } from '@pulse/ui/components/form';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import {
  addEmployeeDocumentAction,
  archiveEmployeeDocumentAction,
  createCertificationAction,
  setSkillsAction,
  updateCertificationAction,
  updateEmployeeDocumentAction,
  updateExpiryAlertSettingsAction,
} from '@/lib/actions/talent';
import type { UploadHint } from '@/lib/upload-hints';

// Spec: docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22,
// docs/modules/talent.md#skills--certifications (decisions 178–188) and
// docs/DESIGN_SYSTEM.md#layout--components ("Documents and certifications") — the inspector's
// sheets for the 201 file (Add, Edit, Archive), the skills, the certifications (Add, Edit), and the
// Talent Owner's "Expiry alerts" settings sheet on `/talent`.
//
// - Uploads use a file field that names the accepted types and the size limit (from the upload
//   settings). 201 documents and attachments are stored byte for byte; the file of a 201 document
//   can't be changed, so a renewal is a new document that can archive the one it replaces.
// - Edits send back the `version` they loaded; a stale save offers Reload. Save is ⌘S or Ctrl+S.
// - Errors come back inline next to each field. Nothing here is logged.

/** A Core product for the certification's optional product picker. */
export interface BrandOption {
  id: string;
  name: string;
}

const SAVE = ['mod', 's'] as const;
const SAVE_FAILED = 'The changes weren’t saved. Check your connection and try again.';

export type DocumentSheet =
  | { kind: 'addDocument' }
  | { kind: 'editDocument'; document: EmployeeDocumentView }
  | { kind: 'archiveDocument'; document: EmployeeDocumentView }
  | { kind: 'skills' }
  | { kind: 'addCertification' }
  | { kind: 'editCertification'; certification: CertificationView };

type SubmitAction = Parameters<typeof useActionSubmit<unknown>>[0];

/** A stale form or a record that went away (the shared list of those refusals). */
function needsReload(message: string | null): boolean {
  return message !== null && STALE_FORM_MESSAGES.includes(message);
}

/** The shared form inside a sheet: header, errors, fields, and Cancel and the submit button. */
export function FormSheet({
  title,
  description,
  action,
  submitLabel,
  destructive = false,
  disabled = false,
  onSaved,
  onReload,
  children,
}: {
  title: string;
  description: string;
  action: SubmitAction;
  submitLabel: string;
  destructive?: boolean;
  disabled?: boolean;
  onSaved: () => void;
  onReload?: () => void;
  children: (errors: FieldErrors) => ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const save = useActionSubmit(action, onSaved);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const stale = onReload !== undefined && needsReload(save.formError);

  useShortcut(SAVE, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  async function submit(form: HTMLFormElement) {
    setNetworkError(null);
    try {
      const ok = await save.run(new FormData(form));
      if (!ok) {
        requestAnimationFrame(() => {
          form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
        });
      }
    } catch {
      setNetworkError(SAVE_FAILED);
    }
  }

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
      className="flex min-h-0 flex-1 flex-col"
      aria-busy={save.pending || undefined}
    >
      <SheetHeader title={title} description={description} />
      <SheetBody>
        {stale ? (
          <div
            role="alert"
            className="flex flex-col gap-3 rounded-card bg-surface px-4 py-3 shadow-card sm:flex-row sm:items-center"
          >
            <p className="flex flex-1 items-start gap-2 text-footnote font-medium text-destructive-text">
              <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
              <span>{save.formError}</span>
            </p>
            <Button variant="tinted" onClick={onReload} className="shrink-0">
              <RotateCw aria-hidden="true" className="size-4.5" />
              Reload
            </Button>
          </div>
        ) : (
          <FormAlert message={save.formError ?? networkError} />
        )}
        {children(save.fieldErrors)}
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Cancel
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        <Button
          type="submit"
          variant={destructive ? 'destructive' : 'primary'}
          loading={save.pending}
          disabled={stale || disabled}
          aria-keyshortcuts={ariaKeyShortcuts(SAVE)}
          className="pr-3"
        >
          {submitLabel}
          <ShortcutHint keys={SAVE} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}

/** A file field's input: native, at least 44px tall, its button tinted. */
function FileInput({
  name,
  accept,
  required = false,
}: {
  name: string;
  accept: string;
  required?: boolean;
}) {
  return (
    <Input
      type="file"
      name={name}
      accept={accept || undefined}
      required={required}
      disabled={!accept}
      className={cn(
        'h-auto min-h-11 cursor-pointer py-1.5',
        'file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border-0 file:bg-accent-subtle file:px-3 file:text-subheadline file:font-semibold file:text-accent',
      )}
    />
  );
}

/** The sheet for `sheet` on `view`. Keyed per opening by the parent, so each opens afresh. */
export function DocumentRecordSheet({
  sheet,
  view,
  brands,
  documentUpload,
  onSaved,
  onReload,
}: {
  sheet: DocumentSheet;
  view: EmployeeRecordView;
  /** Core's live products, for a certification's optional product. */
  brands: BrandOption[];
  /** The accepted types and size limit for 201 documents and attachments. */
  documentUpload: UploadHint;
  /** After a save: closes the sheet and shows `message`. */
  onSaved: (message: string) => void;
  /** After a stale-form message: closes the sheet and loads the record again. */
  onReload: () => void;
}) {
  const description = `${view.identity.firstName} ${view.identity.lastName} · ${view.identity.employeeNumber}`;
  switch (sheet.kind) {
    case 'addDocument':
      return (
        <FormSheet
          title="Add document"
          description={description}
          action={addEmployeeDocumentAction}
          submitLabel="Add document"
          onSaved={() => onSaved('Document added.')}
          onReload={onReload}
        >
          {(errors) => (
            <>
              <input type="hidden" name="employeeId" value={view.employeeId} />
              <DocumentDetailFields errors={errors} />
              <FormSection
                title="File"
                footer="The file can’t be changed later. A renewal is uploaded as a new document."
              >
                <FormField label="File" required hint={documentUpload.hint} error={errors.file}>
                  <FileInput name="file" accept={documentUpload.accept} required />
                </FormField>
              </FormSection>
              <ReplacesField documents={view.documents ?? []} errors={errors} />
            </>
          )}
        </FormSheet>
      );
    case 'editDocument':
      return (
        <FormSheet
          title="Edit document"
          description={description}
          action={updateEmployeeDocumentAction}
          submitLabel="Save"
          onSaved={() => onSaved('Changes saved.')}
          onReload={onReload}
        >
          {(errors) => (
            <>
              <input type="hidden" name="documentId" value={sheet.document.id} />
              <input type="hidden" name="version" value={sheet.document.version} />
              <DocumentDetailFields errors={errors} document={sheet.document} />
              <p className="px-4 text-footnote text-text-secondary">
                The file can’t be changed. To replace it, add the new document and choose this one
                under “Replaces”.
              </p>
            </>
          )}
        </FormSheet>
      );
    case 'archiveDocument':
      return (
        <FormSheet
          title="Archive document"
          description={description}
          action={archiveEmployeeDocumentAction}
          submitLabel="Archive document"
          destructive
          onSaved={() => onSaved('Document archived.')}
          onReload={onReload}
        >
          {(errors) => (
            <>
              <input type="hidden" name="documentId" value={sheet.document.id} />
              <input type="hidden" name="version" value={sheet.document.version} />
              <FormSection
                title={sheet.document.title ?? sheet.document.typeLabel}
                footer="Archived documents are kept forever. They show under “Show archived” and no longer raise expiry alerts."
              >
                <FormField label="Reason" required error={errors.reason}>
                  <Textarea name="reason" maxLength={ARCHIVE_REASON_MAX_LENGTH} required />
                </FormField>
              </FormSection>
            </>
          )}
        </FormSheet>
      );
    case 'skills':
      return (
        <FormSheet
          title="Edit skills"
          description={description}
          action={setSkillsAction}
          submitLabel="Save"
          onSaved={() => onSaved('Skills saved.')}
          onReload={onReload}
        >
          {(errors) => (
            <>
              <input type="hidden" name="employeeId" value={view.employeeId} />
              <input type="hidden" name="version" value={view.version} />
              <FormSection title="Skills">
                <FormField
                  label="Skills"
                  hint={`One per line, or separated by commas. Up to ${SKILLS_MAX_COUNT}, each up to ${SKILL_MAX_LENGTH} characters.`}
                  error={errors.skills}
                >
                  <Textarea
                    name="skills"
                    rows={6}
                    defaultValue={view.skills.join('\n')}
                    autoComplete="off"
                  />
                </FormField>
              </FormSection>
            </>
          )}
        </FormSheet>
      );
    case 'addCertification':
      return (
        <FormSheet
          title="Add certification"
          description={description}
          action={createCertificationAction}
          submitLabel="Add certification"
          onSaved={() => onSaved('Certification added.')}
          onReload={onReload}
        >
          {(errors) => (
            <>
              <input type="hidden" name="employeeId" value={view.employeeId} />
              <CertificationFields errors={errors} brands={brands} upload={documentUpload} />
            </>
          )}
        </FormSheet>
      );
    case 'editCertification':
      return (
        <FormSheet
          title="Edit certification"
          description={description}
          action={updateCertificationAction}
          submitLabel="Save"
          onSaved={() => onSaved('Changes saved.')}
          onReload={onReload}
        >
          {(errors) => (
            <>
              <input type="hidden" name="certificationId" value={sheet.certification.id} />
              <input type="hidden" name="version" value={sheet.certification.version} />
              <CertificationFields
                errors={errors}
                brands={brands}
                upload={documentUpload}
                certification={sheet.certification}
              />
            </>
          )}
        </FormSheet>
      );
  }
}

/** The issue date and the optional expiry date. */
function DateFields({
  errors,
  issueDate,
  expiryDate,
  futureIssueDate = false,
}: {
  errors: FieldErrors;
  issueDate?: string;
  expiryDate?: string | null;
  /** A certification may carry a future issue date; a 201 document may not. */
  futureIssueDate?: boolean;
}) {
  return (
    <>
      <FormField label="Issue date" required error={errors.issueDate}>
        <Input
          type="date"
          name="issueDate"
          defaultValue={issueDate ?? ''}
          max={futureIssueDate ? undefined : businessToday()}
          required
          className="numeric sm:max-w-60"
        />
      </FormField>
      <FormField
        label="Expiry date"
        hint="Leave it empty if it doesn’t expire. Expiry alerts go out before this date."
        error={errors.expiryDate}
      >
        <Input
          type="date"
          name="expiryDate"
          defaultValue={expiryDate ?? ''}
          className="numeric sm:max-w-60"
        />
      </FormField>
    </>
  );
}

function DocumentDetailFields({
  errors,
  document,
}: {
  errors: FieldErrors;
  document?: EmployeeDocumentView;
}) {
  const [type, setType] = useState<Document201Type | ''>(document?.type ?? '');
  return (
    <FormSection title="Document">
      <FormField label="Type" required error={errors.type}>
        <Select
          name="type"
          value={type}
          onChange={(event) => setType(event.target.value as Document201Type | '')}
          required
        >
          <option value="" disabled>
            Choose a type
          </option>
          {DOCUMENT_201_TYPES.map((value) => (
            <option key={value} value={value}>
              {DOCUMENT_201_TYPE_LABELS[value]}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField
        label="Title"
        required={type === 'other'}
        hint={type === 'other' ? 'Name the document.' : 'Optional, like “2026 NBI clearance”.'}
        error={errors.title}
      >
        <Input
          name="title"
          defaultValue={document?.title ?? ''}
          maxLength={DOCUMENT_TITLE_MAX_LENGTH}
          autoComplete="off"
        />
      </FormField>
      <DateFields
        errors={errors}
        issueDate={document?.issueDate}
        expiryDate={document?.expiryDate}
      />
    </FormSection>
  );
}

/** "Replaces": a current document this renewal archives in the same save. */
function ReplacesField({
  documents,
  errors,
}: {
  documents: EmployeeDocumentView[];
  errors: FieldErrors;
}) {
  const current = documents.filter((document) => !document.archived);
  const [replacesId, setReplacesId] = useState('');
  const replaced = current.find((document) => document.id === replacesId) ?? null;
  if (current.length === 0) return null;
  return (
    <FormSection
      title="Renewal"
      footer="The document it replaces is archived with the reason “Replaced by a renewed document.”"
    >
      <FormField label="Replaces" error={errors.replacesDocumentId ?? errors.replacesVersion}>
        <Select
          name="replacesDocumentId"
          value={replacesId}
          onChange={(event) => setReplacesId(event.target.value)}
        >
          <option value="">Nothing</option>
          {current.map((document) => (
            <option key={document.id} value={document.id}>
              {document.title ?? document.typeLabel} · issued {formatDate(document.issueDate)}
            </option>
          ))}
        </Select>
      </FormField>
      {replaced ? <input type="hidden" name="replacesVersion" value={replaced.version} /> : null}
    </FormSection>
  );
}

function CertificationFields({
  errors,
  brands,
  upload,
  certification,
}: {
  errors: FieldErrors;
  brands: BrandOption[];
  upload: UploadHint;
  certification?: CertificationView;
}) {
  const [removeAttachment, setRemoveAttachment] = useState(false);
  const product = certification?.product ?? null;
  const retiredProduct = product && !brands.some((brand) => brand.id === product.id);
  return (
    <>
      <FormSection title="Certification">
        <FormField label="Name" required hint="Like “CCNA” or “NC II”." error={errors.name}>
          <Input
            name="name"
            defaultValue={certification?.name ?? ''}
            maxLength={CERTIFICATION_NAME_MAX_LENGTH}
            autoComplete="off"
            required
          />
        </FormField>
        <FormField
          label="Issued by"
          required
          hint="Like Cisco, Fortinet, TESDA or PRC."
          error={errors.issuer}
        >
          <Input
            name="issuer"
            defaultValue={certification?.issuer ?? ''}
            maxLength={CERTIFICATION_ISSUER_MAX_LENGTH}
            autoComplete="off"
            required
          />
        </FormField>
        <FormField
          label="Product"
          hint="Optional. Pulse Engage counts certified employees per product."
          error={errors.brandId}
        >
          <Select name="brandId" defaultValue={product?.id ?? ''}>
            <option value="">None</option>
            {retiredProduct ? (
              <option value={product.id}>{product.name ?? 'Retired product'}</option>
            ) : null}
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Certificate or license number" error={errors.licenseNumber}>
          <Input
            name="licenseNumber"
            defaultValue={certification?.licenseNumber ?? ''}
            maxLength={LICENSE_NUMBER_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        <DateFields
          errors={errors}
          issueDate={certification?.issueDate}
          expiryDate={certification?.expiryDate}
          futureIssueDate
        />
      </FormSection>
      <FormSection title="Attachment">
        {certification?.attachmentUrl ? (
          <FormField label="Remove the attachment" layout="inline" error={errors.removeAttachment}>
            <Switch
              name="removeAttachment"
              checked={removeAttachment}
              onCheckedChange={setRemoveAttachment}
            />
          </FormField>
        ) : null}
        {removeAttachment ? null : (
          <FormField
            label={certification?.attachmentUrl ? 'Replace the attachment' : 'Attachment'}
            hint={`Optional. ${upload.hint}`}
            error={errors.attachment}
          >
            <FileInput name="attachment" accept={upload.accept} />
          </FormField>
        )}
      </FormSection>
    </>
  );
}

/** The Talent Owner's "Expiry alerts" sheet: how many days ahead the alerts go out. */
export function ExpiryAlertsSheet({
  settings,
  onSaved,
}: {
  settings: ExpiryAlertSettingsView;
  onSaved: (message: string) => void;
}) {
  const range = `${EXPIRY_LEAD_DAYS_MIN} to ${EXPIRY_LEAD_DAYS_MAX} days.`;
  return (
    <FormSheet
      title="Expiry alerts"
      description="How many days before an expiry date HR, the employee and, for certifications, their supervisors are alerted."
      action={updateExpiryAlertSettingsAction}
      submitLabel="Save"
      disabled={settings.changedToday}
      onSaved={() => onSaved('Expiry alert settings saved. They take effect today.')}
    >
      {(errors) => (
        <>
          {settings.changedToday ? (
            <p className="rounded-card bg-surface px-4 py-3 text-footnote font-medium text-text-secondary shadow-card">
              These settings were already changed today. Only one change can take effect per day:
              change them again tomorrow.
            </p>
          ) : null}
          <FormSection
            title="Days before expiry"
            footer={
              settings.effectiveFrom
                ? `In effect since ${formatDate(settings.effectiveFrom)}. A change takes effect today and is recorded in the audit log.`
                : 'The defaults are in effect. A change takes effect today and is recorded in the audit log.'
            }
          >
            <FormField label="201 documents" required hint={range} error={errors.documentLeadDays}>
              <Input
                type="number"
                name="documentLeadDays"
                inputMode="numeric"
                min={EXPIRY_LEAD_DAYS_MIN}
                max={EXPIRY_LEAD_DAYS_MAX}
                step={1}
                defaultValue={settings.documentLeadDays}
                disabled={settings.changedToday}
                required
                className="numeric sm:max-w-40"
              />
            </FormField>
            <FormField
              label="Certifications"
              required
              hint={range}
              error={errors.certificationLeadDays}
            >
              <Input
                type="number"
                name="certificationLeadDays"
                inputMode="numeric"
                min={EXPIRY_LEAD_DAYS_MIN}
                max={EXPIRY_LEAD_DAYS_MAX}
                step={1}
                defaultValue={settings.certificationLeadDays}
                disabled={settings.changedToday}
                required
                className="numeric sm:max-w-40"
              />
            </FormField>
          </FormSection>
        </>
      )}
    </FormSheet>
  );
}
