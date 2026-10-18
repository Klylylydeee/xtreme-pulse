'use client';

import { Fragment, type ReactNode, useRef, useState } from 'react';
import Link from 'next/link';
import { CircleAlert, Clock, RotateCw } from 'lucide-react';
import { businessToday, type FieldErrors, formDataToObject } from '@pulse/core';
import {
  ACCOUNT_NAME_MAX_LENGTH,
  ADDRESS_MAX_LENGTH,
  CERTIFICATION_ISSUER_MAX_LENGTH,
  CERTIFICATION_NAME_MAX_LENGTH,
  CHANGE_REQUEST_NOTE_MAX_LENGTH,
  CHANGE_REQUEST_PENDING_NOTICE,
  CHANGE_REQUEST_RETURNED_NOTICE,
  CHANGE_REQUEST_SECTION_FIELDS,
  CHANGE_REQUEST_SECTION_LABELS,
  type ChangeRequestField,
  type ChangeRequestSection,
  changeRequestHref,
  CIVIL_STATUS_LABELS,
  CIVIL_STATUSES,
  DOCUMENT_201_TYPE_LABELS,
  DOCUMENT_TITLE_MAX_LENGTH,
  type Document201Type,
  EMERGENCY_CONTACT_NAME_MAX_LENGTH,
  EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH,
  type EmployeeRecordView,
  LICENSE_NUMBER_MAX_LENGTH,
  type MaskedDigitsView,
  NATIONALITY_MAX_LENGTH,
  OWN_SECTION_SCHEMAS,
  type OwnChangeRequestListItem,
  ownEditFooter,
  ownFieldChange,
  ownSaveButtonLabel,
  type OwnSaveResult,
  type OwnSection,
  ownSectionSaveKind,
  type OwnSectionEditView,
  PAYROLL_BANK_LABELS,
  PAYROLL_BANKS,
  PERSONAL_EMAIL_MAX_LENGTH,
  SEX_LABELS,
  SEXES,
  SKILL_MAX_LENGTH,
  SKILLS_MAX_COUNT,
  STALE_FORM_MESSAGES,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input, Select, Textarea } from '@pulse/ui/components/form';
import { SheetBody, SheetClose, SheetFooter, SheetHeader } from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { FormAlert } from '@/components/form-alert';
import { useActionSubmit } from '@/components/org-structure';
import { resendChangeRequestAction } from '@/lib/actions/talent-change-requests';
import {
  addOwnCertificationAction,
  addOwnDocumentAction,
  saveOwnBankAccountAction,
  saveOwnGovernmentIdsAction,
  saveOwnPersonalAction,
  saveOwnSkillsAction,
} from '@/lib/actions/talent-self';
import type { UploadHint } from '@/lib/upload-hints';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("What the
// employee changes themselves", "Change requests", "Screens"; decisions 266–268 and 275 in
// docs/BUILD_PLAN.md) and docs/DESIGN_SYSTEM.md#layout--components — the employee's own sheets on
// `/talent/me` and the onboarding checklist: the Edit sheets of Personal (with the emergency
// contact), Government IDs, Payroll bank account and Skills; "Edit and send again" on a returned
// change request; "Upload document"; and "Add certification". Each acts on the signed-in user's own
// employee: no form sends an employee id.
//
// - The Edit sheet's button reads "Save" while the form only fills empty fields, and "Send for
//   approval" once it changes or clears a filled-in one, worked out as the user types with the
//   same rules as the server (`ownFieldChange`). A typed government ID or account number counts as
//   a change when one is stored, since the sheet never holds the stored value; the server decides
//   again with the real value, and its answer says what was saved and what was sent.
// - Each part of a sheet says who approves its changes. A part with an open change request can't be
//   changed here: its values go back unchanged, and a link opens the request instead.
// - Sensitive inputs are never filled in: they start empty with "Ends in 1234", and empty keeps the
//   stored value. Errors come back inline; no message repeats a value. Save is ⌘S or Ctrl+S.

const SAVE = ['mod', 's'] as const;
const SAVE_FAILED = 'The changes weren’t saved. Check your connection and try again.';

/** The change request sections each on-screen section holds, in order. */
const OWN_SECTION_PARTS: Record<OwnSection, readonly ChangeRequestSection[]> = {
  personal: ['personal', 'contact'],
  governmentIds: ['governmentIds'],
  bankAccount: ['bankAccount'],
  skills: ['skills'],
};

/** The on-screen section a change request section is edited in. */
export function ownSectionOf(section: ChangeRequestSection): OwnSection {
  return section === 'contact' ? 'personal' : section;
}

export const OWN_SHEET_TITLES: Record<OwnSection, string> = {
  personal: 'Edit personal details',
  governmentIds: 'Edit government IDs',
  bankAccount: 'Edit payroll bank account',
  skills: 'Edit skills',
};

export type OwnSectionStates = Record<ChangeRequestSection, OwnSectionEditView>;

/** What an own sheet is for. */
export type OwnSheet =
  | { kind: 'section'; section: OwnSection }
  | { kind: 'resend'; request: OwnChangeRequestListItem }
  | { kind: 'addDocument' }
  | { kind: 'addCertification' };

/** A Core product for the certification's optional product picker. */
export interface OwnBrandOption {
  id: string;
  name: string;
}

type SubmitAction = Parameters<typeof useActionSubmit<unknown>>[0];

function needsReload(message: string | null): boolean {
  return message !== null && STALE_FORM_MESSAGES.includes(message);
}

/** The record's current value of each change request field; a stored sensitive value is `true`. */
function currentValues(view: EmployeeRecordView): Record<ChangeRequestField, unknown> {
  const personal = view.personal;
  const ids = view.governmentIds;
  const bank = view.bankAccount;
  const stored = (value: MaskedDigitsView | null | undefined) => (value ? true : null);
  return {
    presentAddress: personal.presentAddress,
    permanentAddress: personal.permanentAddress,
    mobileNumber: personal.mobileNumber,
    personalEmail: personal.personalEmail,
    emergencyContact: personal.emergencyContact,
    skills: view.skills,
    dateOfBirth: personal.dateOfBirth ?? null,
    sex: personal.sex,
    civilStatus: personal.civilStatus ?? null,
    nationality: personal.nationality,
    tin: stored(ids?.tin),
    rdoCode: ids?.rdoCode ?? null,
    sss: stored(ids?.sss),
    philhealth: stored(ids?.philhealth),
    pagibig: stored(ids?.pagibig),
    bank: bank?.bank ?? null,
    accountNumber: stored(bank?.accountNumber),
    accountName: bank?.accountName ?? null,
  };
}

/** A parsed sheet's new value of each field it holds (`undefined` keeps the stored value). */
function formValues(parsed: Record<string, unknown>): Partial<Record<ChangeRequestField, unknown>> {
  const contact = {
    name: (parsed.emergencyContactName as string | null | undefined) ?? null,
    relationship: (parsed.emergencyContactRelationship as string | null | undefined) ?? null,
    mobileNumber: (parsed.emergencyContactMobile as string | null | undefined) ?? null,
  };
  const values: Partial<Record<ChangeRequestField, unknown>> = { ...parsed };
  if ('emergencyContactName' in parsed) {
    values.emergencyContact = Object.values(contact).some((value) => value !== null)
      ? contact
      : null;
  }
  return values;
}

/** The button's label for the form as it is now, or null when it can't be parsed yet. */
function saveLabelOf(
  section: OwnSection,
  parts: readonly ChangeRequestSection[],
  view: EmployeeRecordView,
  form: HTMLFormElement,
): string | null {
  const parsed = OWN_SECTION_SCHEMAS[section].safeParse(formDataToObject(new FormData(form)));
  if (!parsed.success) return null;
  const next = formValues(parsed.data as Record<string, unknown>);
  const current = currentValues(view);
  return ownSaveButtonLabel(
    parts.map((part) =>
      ownSectionSaveKind(
        (CHANGE_REQUEST_SECTION_FIELDS[part] as readonly ChangeRequestField[]).map((field) =>
          ownFieldChange(current[field], next[field]),
        ),
      ),
    ),
  );
}

/** What an own save did, in a sentence: what was saved, and what went for approval. */
export function ownSaveMessage(result: OwnSaveResult): string {
  const sent = result.sent.map((request) => CHANGE_REQUEST_SECTION_LABELS[request.section]);
  if (sent.length === 0) return 'Changes saved.';
  const sentText = `Sent for approval: ${sent.join(', ')}.`;
  return result.saved.length > 0 ? `Empty fields saved. ${sentText}` : sentText;
}

/** The sheet's form: header, errors (with Reload for a stale form), fields, Cancel and submit. */
function OwnFormSheet({
  title,
  description,
  action,
  submitLabel,
  onSaved,
  onReload,
  onFormChange,
  children,
}: {
  title: string;
  description: string;
  action: SubmitAction;
  submitLabel: string;
  onSaved: (data: unknown) => void;
  onReload: () => void;
  onFormChange?: (form: HTMLFormElement) => void;
  children: (errors: FieldErrors) => ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const save = useActionSubmit(action, onSaved);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const stale = needsReload(save.formError);

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
      onChange={(event) => onFormChange?.(event.currentTarget)}
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
          loading={save.pending}
          disabled={stale}
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

/** The sheet for `sheet`. Keyed per opening by the parent, so each opens afresh. */
export function OwnRecordSheet({
  sheet,
  view,
  states,
  brands,
  documentUpload,
  uploadTypes,
  onSaved,
  onReload,
}: {
  sheet: OwnSheet;
  view: EmployeeRecordView;
  states: OwnSectionStates;
  brands: OwnBrandOption[];
  documentUpload: UploadHint;
  /** The 201 document types the employee may upload. */
  uploadTypes: readonly Document201Type[];
  /** After a save: closes the sheet and shows `message`. */
  onSaved: (message: string) => void;
  /** After a stale-form message: closes the sheet and loads the record again. */
  onReload: () => void;
}) {
  const description = `${view.identity.firstName} ${view.identity.lastName} · ${view.identity.employeeNumber}`;
  switch (sheet.kind) {
    case 'section':
    case 'resend':
      return (
        <OwnSectionSheet
          sheet={sheet}
          view={view}
          states={states}
          description={description}
          onSaved={onSaved}
          onReload={onReload}
        />
      );
    case 'addDocument':
      return (
        <OwnFormSheet
          title="Upload document"
          description={description}
          action={addOwnDocumentAction}
          submitLabel="Upload document"
          onSaved={() => onSaved('Document uploaded. HR has been told.')}
          onReload={onReload}
        >
          {(errors) => (
            <>
              <OwnDocumentFields errors={errors} types={uploadTypes} />
              <FormSection
                title="File"
                footer="HR issues the employment contract and the regularization evaluation. Only HR edits or archives a document."
              >
                <FormField label="File" required hint={documentUpload.hint} error={errors.file}>
                  <FileInput name="file" accept={documentUpload.accept} required />
                </FormField>
              </FormSection>
            </>
          )}
        </OwnFormSheet>
      );
    case 'addCertification':
      return (
        <OwnFormSheet
          title="Add certification"
          description={description}
          action={addOwnCertificationAction}
          submitLabel="Add certification"
          onSaved={() => onSaved('Certification added.')}
          onReload={onReload}
        >
          {(errors) => (
            <OwnCertificationFields errors={errors} brands={brands} upload={documentUpload} />
          )}
        </OwnFormSheet>
      );
  }
}

function OwnSectionSheet({
  sheet,
  view,
  states,
  description,
  onSaved,
  onReload,
}: {
  sheet: Extract<OwnSheet, { kind: 'section' | 'resend' }>;
  view: EmployeeRecordView;
  states: OwnSectionStates;
  description: string;
  onSaved: (message: string) => void;
  onReload: () => void;
}) {
  const resend = sheet.kind === 'resend' ? sheet.request : null;
  const section = resend
    ? ownSectionOf(resend.section)
    : (sheet as { section: OwnSection }).section;
  const parts = OWN_SECTION_PARTS[section];
  const [label, setLabel] = useState(resend ? 'Send for approval' : 'Save');
  const sending = label === 'Send for approval';

  return (
    <OwnFormSheet
      title={resend ? 'Edit and send again' : OWN_SHEET_TITLES[section]}
      description={description}
      action={(resend ? resendChangeRequestAction : SAVE_ACTIONS[section]) as SubmitAction}
      submitLabel={label}
      onSaved={(data) =>
        onSaved(resend ? 'Sent for approval again.' : ownSaveMessage(data as OwnSaveResult))
      }
      onReload={onReload}
      onFormChange={
        resend
          ? undefined
          : (form) => {
              const next = saveLabelOf(section, parts, view, form);
              if (next) setLabel(next);
            }
      }
    >
      {(errors) => (
        <>
          {resend ? (
            <>
              <input type="hidden" name="changeRequestId" value={resend.id} />
              <div className="flex flex-col gap-1 rounded-card bg-surface px-4 py-3 shadow-card">
                <p className="text-subheadline font-medium">{resend.sectionLabel}: returned</p>
                {resend.remarks ? (
                  <p className="text-footnote break-words text-text-secondary">
                    “{resend.remarks}”
                  </p>
                ) : null}
                <p className="text-footnote text-text-secondary">
                  Make the change again below. Only the fields you change are sent.
                </p>
              </div>
            </>
          ) : (
            <input type="hidden" name="version" value={view.version} />
          )}
          {parts.map((part) => {
            // "Edit and send again" shows only the returned request's part; the other part's
            // values go back unchanged, since the server reads the whole sheet.
            if (resend && part !== resend.section) {
              return <UnchangedPartValues key={part} part={part} view={view} />;
            }
            const open = resend ? null : states[part].openRequest;
            return open ? (
              <Fragment key={part}>
                <UnchangedPartValues part={part} view={view} />
                <FormSection title={CHANGE_REQUEST_SECTION_LABELS[part]}>
                  <OpenRequestNotice request={open} />
                </FormSection>
              </Fragment>
            ) : (
              <PartFields
                key={part}
                part={part}
                view={view}
                errors={errors}
                footer={ownEditFooter(states[part].approvers)}
              />
            );
          })}
          {sending || resend ? (
            <FormSection title="Note for the approver">
              <FormField
                label="Note"
                hint={`Optional. Up to ${CHANGE_REQUEST_NOTE_MAX_LENGTH} characters.`}
                error={errors.note}
              >
                <Textarea name="note" maxLength={CHANGE_REQUEST_NOTE_MAX_LENGTH} />
              </FormField>
            </FormSection>
          ) : null}
        </>
      )}
    </OwnFormSheet>
  );
}

const SAVE_ACTIONS: Record<OwnSection, SubmitAction> = {
  personal: saveOwnPersonalAction as SubmitAction,
  governmentIds: saveOwnGovernmentIdsAction as SubmitAction,
  bankAccount: saveOwnBankAccountAction as SubmitAction,
  skills: saveOwnSkillsAction as SubmitAction,
};

/**
 * A part the sheet doesn't change (one with an open change request, or the other part of a
 * returned request's sheet): its current values go back unchanged as hidden fields, so the save
 * leaves it alone. A stored ID or account number is never sent: empty keeps it.
 */
function UnchangedPartValues({
  part,
  view,
}: {
  part: ChangeRequestSection;
  view: EmployeeRecordView;
}) {
  const personal = view.personal;
  const hidden = (name: string, value: string | null | undefined) => (
    <input key={name} type="hidden" name={name} value={value ?? ''} />
  );
  let fields: ReactNode = null;
  if (part === 'personal') {
    fields = [
      hidden('dateOfBirth', personal.dateOfBirth),
      hidden('sex', personal.sex),
      hidden('civilStatus', personal.civilStatus),
      hidden('nationality', personal.nationality),
    ];
  } else if (part === 'contact') {
    fields = [
      hidden('mobileNumber', personal.mobileNumber),
      hidden('personalEmail', personal.personalEmail),
      hidden('presentAddress', personal.presentAddress),
      hidden('permanentAddress', personal.permanentAddress),
      hidden('emergencyContactName', personal.emergencyContact?.name),
      hidden('emergencyContactRelationship', personal.emergencyContact?.relationship),
      hidden('emergencyContactMobile', personal.emergencyContact?.mobileNumber),
    ];
  } else if (part === 'skills') {
    fields = view.skills.map((skill, index) => (
      <input key={index} type="hidden" name="skills" value={skill} />
    ));
  } else if (part === 'bankAccount') {
    fields = [
      hidden('bank', view.bankAccount?.bank),
      hidden('accountName', view.bankAccount?.accountName),
    ];
  } else {
    fields = [hidden('rdoCode', view.governmentIds?.rdoCode)];
  }
  return <>{fields}</>;
}

/** "A change to this section is waiting for approval" (or "…was returned"), opening the request. */
export function OpenRequestNotice({
  request,
  className,
}: {
  request: NonNullable<OwnSectionEditView['openRequest']>;
  className?: string;
}) {
  return (
    <Link
      href={changeRequestHref(request.id)}
      className={cn(
        'flex min-h-11 items-center gap-2 px-4 py-2.5 text-subheadline font-medium text-accent hover:bg-accent-subtle/50',
        className,
      )}
    >
      <Clock aria-hidden="true" className="size-4.5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 flex-1">
        {request.status === 'returned'
          ? CHANGE_REQUEST_RETURNED_NOTICE
          : CHANGE_REQUEST_PENDING_NOTICE}
      </span>
    </Link>
  );
}

/** The hint on a sensitive input: what is stored, masked, and that empty keeps it. */
function sensitiveHint(stored: MaskedDigitsView | null | undefined, extra?: string): string {
  return [
    stored ? `Ends in ${stored.lastFour}. Leave it empty to keep it.` : 'None stored yet.',
    extra,
  ]
    .filter(Boolean)
    .join(' ');
}

/** A sensitive digits input: never prefilled, no autocomplete, digits keyboard. */
function SensitiveInput({ name, maxLength }: { name: string; maxLength: number }) {
  return (
    <Input
      name={name}
      defaultValue=""
      inputMode="numeric"
      autoComplete="off"
      spellCheck={false}
      maxLength={maxLength}
      className="numeric"
    />
  );
}

function PartFields({
  part,
  view,
  errors,
  footer,
}: {
  part: ChangeRequestSection;
  view: EmployeeRecordView;
  errors: FieldErrors;
  footer: string;
}) {
  const personal = view.personal;
  switch (part) {
    case 'personal':
      return (
        <FormSection title="Personal details" footer={footer}>
          <FormField label="Date of birth" error={errors.dateOfBirth}>
            <Input
              type="date"
              name="dateOfBirth"
              defaultValue={personal.dateOfBirth ?? ''}
              max={businessToday()}
              className="numeric sm:max-w-60"
            />
          </FormField>
          <FormField label="Sex" error={errors.sex}>
            <Select name="sex" defaultValue={personal.sex ?? ''}>
              <option value="">Not set</option>
              {SEXES.map((sex) => (
                <option key={sex} value={sex}>
                  {SEX_LABELS[sex]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Civil status" error={errors.civilStatus}>
            <Select name="civilStatus" defaultValue={personal.civilStatus ?? ''}>
              <option value="">Not set</option>
              {CIVIL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {CIVIL_STATUS_LABELS[status]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Nationality" error={errors.nationality}>
            <Input
              name="nationality"
              defaultValue={personal.nationality ?? ''}
              maxLength={NATIONALITY_MAX_LENGTH}
              autoComplete="off"
            />
          </FormField>
        </FormSection>
      );
    case 'contact': {
      const contact = personal.emergencyContact;
      return (
        <>
          <FormSection title="Contact">
            <FormField
              label="Mobile number"
              hint="11 digits, like 0917 123 4567."
              error={errors.mobileNumber}
            >
              <Input
                name="mobileNumber"
                type="tel"
                inputMode="tel"
                defaultValue={personal.mobileNumber ?? ''}
                maxLength={20}
                autoComplete="off"
                className="numeric"
              />
            </FormField>
            <FormField label="Personal email" hint="Optional." error={errors.personalEmail}>
              <Input
                name="personalEmail"
                type="email"
                defaultValue={personal.personalEmail ?? ''}
                maxLength={PERSONAL_EMAIL_MAX_LENGTH}
                autoComplete="off"
                spellCheck={false}
              />
            </FormField>
            <FormField label="Present address" error={errors.presentAddress}>
              <Textarea
                name="presentAddress"
                defaultValue={personal.presentAddress ?? ''}
                maxLength={ADDRESS_MAX_LENGTH}
              />
            </FormField>
            <FormField label="Permanent address" error={errors.permanentAddress}>
              <Textarea
                name="permanentAddress"
                defaultValue={personal.permanentAddress ?? ''}
                maxLength={ADDRESS_MAX_LENGTH}
              />
            </FormField>
          </FormSection>
          <FormSection title="Emergency contact" footer={footer}>
            <FormField label="Name" error={errors.emergencyContactName}>
              <Input
                name="emergencyContactName"
                defaultValue={contact?.name ?? ''}
                maxLength={EMERGENCY_CONTACT_NAME_MAX_LENGTH}
                autoComplete="off"
              />
            </FormField>
            <FormField label="Relationship" error={errors.emergencyContactRelationship}>
              <Input
                name="emergencyContactRelationship"
                defaultValue={contact?.relationship ?? ''}
                maxLength={EMERGENCY_CONTACT_RELATIONSHIP_MAX_LENGTH}
                autoComplete="off"
              />
            </FormField>
            <FormField
              label="Mobile number"
              hint="11 digits, like 0917 123 4567."
              error={errors.emergencyContactMobile}
            >
              <Input
                name="emergencyContactMobile"
                type="tel"
                inputMode="tel"
                defaultValue={contact?.mobileNumber ?? ''}
                maxLength={20}
                autoComplete="off"
                className="numeric"
              />
            </FormField>
          </FormSection>
        </>
      );
    }
    case 'governmentIds': {
      const ids = view.governmentIds;
      return (
        <FormSection
          title="Government IDs"
          footer={`Dashes and spaces are fine; only the digits are kept. ${footer}`}
        >
          <FormField
            label="TIN"
            hint={sensitiveHint(ids?.tin, '9, 12 or 14 digits.')}
            error={errors.tin}
          >
            <SensitiveInput name="tin" maxLength={24} />
          </FormField>
          <FormField label="RDO code" hint="3 digits." error={errors.rdoCode}>
            <Input
              name="rdoCode"
              defaultValue={ids?.rdoCode ?? ''}
              inputMode="numeric"
              autoComplete="off"
              maxLength={5}
              className="numeric sm:max-w-40"
            />
          </FormField>
          <FormField
            label="SSS number"
            hint={sensitiveHint(ids?.sss, '10 digits.')}
            error={errors.sss}
          >
            <SensitiveInput name="sss" maxLength={20} />
          </FormField>
          <FormField
            label="PhilHealth PIN"
            hint={sensitiveHint(ids?.philhealth, '12 digits.')}
            error={errors.philhealth}
          >
            <SensitiveInput name="philhealth" maxLength={20} />
          </FormField>
          <FormField
            label="Pag-IBIG MID"
            hint={sensitiveHint(ids?.pagibig, '12 digits.')}
            error={errors.pagibig}
          >
            <SensitiveInput name="pagibig" maxLength={20} />
          </FormField>
        </FormSection>
      );
    }
    case 'bankAccount': {
      const bank = view.bankAccount;
      return (
        <FormSection title="Payroll bank account" footer={footer}>
          <FormField label="Bank" required error={errors.bank}>
            <Select name="bank" defaultValue={bank?.bank ?? ''} required>
              <option value="" disabled>
                Choose a bank
              </option>
              {PAYROLL_BANKS.map((value) => (
                <option key={value} value={value}>
                  {PAYROLL_BANK_LABELS[value]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Account number"
            required={!bank?.accountNumber}
            hint={sensitiveHint(bank?.accountNumber, '10 to 16 digits.')}
            error={errors.accountNumber}
          >
            <SensitiveInput name="accountNumber" maxLength={24} />
          </FormField>
          <FormField label="Account name" required error={errors.accountName}>
            <Input
              name="accountName"
              defaultValue={bank?.accountName ?? ''}
              maxLength={ACCOUNT_NAME_MAX_LENGTH}
              autoComplete="off"
              required
            />
          </FormField>
        </FormSection>
      );
    }
    case 'skills':
      return (
        <FormSection title="Skills" footer={footer}>
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
      );
  }
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

/** The issue date and the optional expiry date. */
function DateFields({
  errors,
  futureIssueDate = false,
}: {
  errors: FieldErrors;
  /** A certification may carry a future issue date; a 201 document may not. */
  futureIssueDate?: boolean;
}) {
  return (
    <>
      <FormField label="Issue date" required error={errors.issueDate}>
        <Input
          type="date"
          name="issueDate"
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
        <Input type="date" name="expiryDate" className="numeric sm:max-w-60" />
      </FormField>
    </>
  );
}

function OwnDocumentFields({
  errors,
  types,
}: {
  errors: FieldErrors;
  types: readonly Document201Type[];
}) {
  const [type, setType] = useState<Document201Type | ''>('');
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
          {types.map((value) => (
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
        <Input name="title" maxLength={DOCUMENT_TITLE_MAX_LENGTH} autoComplete="off" />
      </FormField>
      <DateFields errors={errors} />
    </FormSection>
  );
}

function OwnCertificationFields({
  errors,
  brands,
  upload,
}: {
  errors: FieldErrors;
  brands: OwnBrandOption[];
  upload: UploadHint;
}) {
  return (
    <>
      <FormSection
        title="Certification"
        footer="HR edits or removes a certification once it’s added."
      >
        <FormField label="Name" required hint="Like “CCNA” or “NC II”." error={errors.name}>
          <Input
            name="name"
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
            maxLength={CERTIFICATION_ISSUER_MAX_LENGTH}
            autoComplete="off"
            required
          />
        </FormField>
        <FormField label="Product" hint="Optional." error={errors.brandId}>
          <Select name="brandId" defaultValue="">
            <option value="">None</option>
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
            maxLength={LICENSE_NUMBER_MAX_LENGTH}
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        <DateFields errors={errors} futureIssueDate />
      </FormSection>
      <FormSection title="Attachment">
        <FormField label="Attachment" hint={`Optional. ${upload.hint}`} error={errors.attachment}>
          <FileInput name="attachment" accept={upload.accept} />
        </FormField>
      </FormSection>
    </>
  );
}
