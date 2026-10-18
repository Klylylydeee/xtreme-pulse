'use client';

import { type ReactNode, useId, useState } from 'react';
import { Archive, FileText, Lock, Paperclip, PencilLine, Plus, Trash2 } from 'lucide-react';
import { formatDate } from '@pulse/core';
import {
  type CertificationView,
  type EmployeeDocumentView,
  type EmployeeRecordView,
  type ExpiryState,
  expiryBadgeText,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { Switch } from '@pulse/ui/components/form';
import { Badge } from '@/components/org-structure';
import { removeCertificationAction } from '@/lib/actions/talent';
import { RecordCard, RecordSection, Row, SectionActions } from './record-ui';

// Spec: docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22,
// SECURITY.md#sensitive-data and docs/DESIGN_SYSTEM.md#layout--components ("Documents and
// certifications") — the record's Documents and Skills & certifications sections (build step 2.2),
// shared by the `/talent` inspector and `/talent/me`. They show only what the server sent for this
// viewer:
//
// - The 201 file list is in the view only for a viewer who may see it; anyone else gets the one
//   `documentsNotice` line (and Accounting gets it under the list, for medical certificates).
// - Each row's expiry badge carries text ("Expired", "Expires in N days", "Valid"), so color is
//   never the only signal. Archived documents hide behind "Show archived".
// - Open goes to the file route, which checks access again and records every open of a 201
//   document in the audit log before sending it.
// - The e-signature shows as its status only: its image is for its owner, on `/talent/me`.
// - Upload, Edit, Archive and the certification actions show only when the view's `can` flags
//   allow them, and only where handlers are given (the inspector); the services check again.
//   Nothing here is logged.

/** The inspector's handlers. Without them, as on `/talent/me`, the sections are read-only. */
export interface DocumentHandlers {
  onAddDocument: () => void;
  onEditDocument: (document: EmployeeDocumentView) => void;
  onArchiveDocument: (document: EmployeeDocumentView) => void;
  onEditSkills: () => void;
  onAddCertification: () => void;
  onEditCertification: (certification: CertificationView) => void;
  /** After a change made in place (removing a certification): reload and show `message`. */
  onChanged: (message: string) => void;
}

const EXPIRY_TONES: Record<ExpiryState['status'], string> = {
  expired: 'text-destructive-text',
  expiring: 'text-warning-text',
  valid: 'text-text-secondary',
  none: 'text-text-secondary',
};

/** The expiry badge: text first, its tone only a second signal. Nothing without an expiry date. */
export function ExpiryBadge({ expiry }: { expiry: ExpiryState }) {
  const text = expiryBadgeText(expiry);
  if (!text) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md bg-bg-grouped px-2 py-0.5 text-footnote font-medium whitespace-nowrap',
        EXPIRY_TONES[expiry.status],
      )}
    >
      {text}
    </span>
  );
}

/** The e-signature status line, for everyone: never the image. */
export function eSignatureStatusText(version: number | null): string {
  return version === null ? 'Not uploaded' : `E-signature on file, version ${version}`;
}

/** A small action in a list row, at least 44px tall. */
function RowAction({
  icon,
  label,
  accessibleLabel,
  onClick,
  destructive = false,
}: {
  icon: ReactNode;
  label: string;
  accessibleLabel: string;
  onClick?: () => void;
  destructive?: boolean;
}) {
  return (
    <Button
      variant="plain"
      onClick={onClick}
      aria-label={accessibleLabel}
      className={cn('px-3', destructive && 'text-destructive-text hover:text-destructive-text')}
    >
      {icon}
      {label}
    </Button>
  );
}

/** A link styled as a row action, for Open. */
function OpenLink({
  href,
  label,
  accessibleLabel,
}: {
  href: string;
  label: string;
  accessibleLabel: string;
}) {
  return (
    <a
      href={href}
      aria-label={accessibleLabel}
      rel="noopener"
      className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-subheadline font-semibold text-accent hover:bg-accent-subtle"
    >
      <FileText aria-hidden="true" className="size-4.5" />
      {label}
    </a>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-3 rounded-card bg-surface px-4 py-3 text-subheadline text-text-secondary shadow-card">
      <Lock aria-hidden="true" className="mt-0.5 size-4.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

// --- Documents ---------------------------------------------------------------------------------

/**
 * The Documents section: an optional photo slot (the inspector's photo with Change and Remove),
 * the e-signature status, and the 201 file.
 */
export function DocumentsSection({
  view,
  handlers,
  photoSlot,
  showESignature = true,
}: {
  view: EmployeeRecordView;
  handlers?: DocumentHandlers;
  photoSlot?: ReactNode;
  /** False on `/talent/me`, which shows the signature itself in its own section. */
  showESignature?: boolean;
}) {
  const { can } = view;
  const manage = handlers && can.manageDocuments ? handlers : null;
  return (
    <RecordSection
      title="Documents"
      action={
        manage ? (
          <Button variant="plain" onClick={manage.onAddDocument}>
            <Plus aria-hidden="true" className="size-4.5" />
            Add document
          </Button>
        ) : null
      }
    >
      {photoSlot || showESignature ? (
        <RecordCard>
          {photoSlot}
          {showESignature ? (
            <Row term="E-signature">{eSignatureStatusText(view.eSignature.version)}</Row>
          ) : null}
        </RecordCard>
      ) : null}
      {view.documents ? (
        <DocumentList
          documents={view.documents}
          name={`${view.identity.firstName} ${view.identity.lastName}`}
          manage={manage}
        />
      ) : null}
      {view.documentsNotice ? <Notice>{view.documentsNotice}</Notice> : null}
    </RecordSection>
  );
}

function DocumentList({
  documents,
  name,
  manage,
}: {
  documents: EmployeeDocumentView[];
  name: string;
  manage: DocumentHandlers | null;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const switchId = useId();
  const listId = useId();
  const current = documents.filter((document) => !document.archived);
  const archivedCount = documents.length - current.length;
  const shown = showArchived ? documents : current;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 pl-4">
        <h4 id={listId} className="text-footnote font-semibold text-text-secondary">
          201 file
        </h4>
        {archivedCount > 0 ? (
          <div className="flex min-h-11 items-center gap-3">
            <label htmlFor={switchId} className="text-subheadline font-medium text-text-primary">
              Show archived ({archivedCount})
            </label>
            <Switch id={switchId} checked={showArchived} onCheckedChange={setShowArchived} />
          </div>
        ) : null}
      </div>
      {shown.length > 0 ? (
        <ol
          aria-labelledby={listId}
          className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
        >
          {shown.map((document) => (
            <DocumentRow key={document.id} document={document} name={name} manage={manage} />
          ))}
        </ol>
      ) : (
        <p className="rounded-card bg-surface px-4 py-3 text-subheadline text-text-secondary shadow-card">
          {archivedCount > 0
            ? 'No current documents. Turn on “Show archived” to see the archived ones.'
            : 'No documents in the 201 file yet.'}
        </p>
      )}
      <p className="px-4 text-footnote text-text-secondary">
        Each time a document is opened, it’s recorded.
      </p>
    </div>
  );
}

function DocumentRow({
  document,
  name,
  manage,
}: {
  document: EmployeeDocumentView;
  name: string;
  manage: DocumentHandlers | null;
}) {
  const heading = document.title ?? document.typeLabel;
  const label = `${heading} for ${name}`;
  return (
    <li className="flex flex-col gap-1 py-2.5">
      <div className="flex flex-wrap items-center gap-2 px-4">
        <span className="text-subheadline font-semibold break-words">{heading}</span>
        {document.archived ? <Badge>Archived</Badge> : <ExpiryBadge expiry={document.expiry} />}
      </div>
      {document.title ? (
        <p className="px-4 text-footnote text-text-secondary">{document.typeLabel}</p>
      ) : null}
      <p className="numeric px-4 text-footnote text-text-secondary">
        Issued {formatDate(document.issueDate)}
        {document.expiryDate ? ` · Expires ${formatDate(document.expiryDate)}` : ' · No expiry'}
      </p>
      <p className="px-4 text-footnote text-text-secondary">
        Uploaded {document.uploadedByName ? `by ${document.uploadedByName} ` : ''}on{' '}
        <span className="numeric">{formatDate(document.uploadedAt)}</span>
      </p>
      {document.archived && document.archiveReason ? (
        <p className="px-4 text-footnote break-words text-text-primary">
          Archived{document.archivedAt ? ` on ${formatDate(document.archivedAt)}` : ''}:{' '}
          {document.archiveReason}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-1 px-1">
        <OpenLink href={document.fileUrl} label="Open" accessibleLabel={`Open ${label}`} />
        {manage && !document.archived ? (
          <>
            <RowAction
              icon={<PencilLine aria-hidden="true" className="size-4.5" />}
              label="Edit"
              accessibleLabel={`Edit ${label}`}
              onClick={() => manage.onEditDocument(document)}
            />
            <RowAction
              icon={<Archive aria-hidden="true" className="size-4.5" />}
              label="Archive"
              accessibleLabel={`Archive ${label}`}
              onClick={() => manage.onArchiveDocument(document)}
              destructive
            />
          </>
        ) : null}
      </div>
    </li>
  );
}

// --- Skills & certifications -------------------------------------------------------------------

/** The Skills & certifications section: the skills tags, then the certifications. */
export function SkillsCertificationsSection({
  view,
  handlers,
  skillsAction,
}: {
  view: EmployeeRecordView;
  handlers?: DocumentHandlers;
  /** An extra action beside Skills' Edit (step 2.6: "Request change" on `/talent/me`). */
  skillsAction?: ReactNode;
}) {
  const { can, skills, certifications } = view;
  const name = `${view.identity.firstName} ${view.identity.lastName}`;
  const skillsId = useId();
  const certificationsId = useId();
  return (
    <RecordSection title="Skills & certifications">
      <div className="flex flex-col gap-2">
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 pl-4">
          <h4 id={skillsId} className="text-footnote font-semibold text-text-secondary">
            Skills
          </h4>
          <SectionActions>
            {handlers && can.editSkills ? (
              <Button variant="plain" onClick={handlers.onEditSkills} aria-label="Edit skills">
                <PencilLine aria-hidden="true" className="size-4.5" />
                Edit
              </Button>
            ) : null}
            {skillsAction}
          </SectionActions>
        </div>
        <div className="rounded-card bg-surface px-4 py-3 shadow-card">
          {skills.length > 0 ? (
            <ul aria-labelledby={skillsId} className="flex flex-wrap gap-2">
              {skills.map((skill) => (
                <li key={skill}>
                  <Badge tone="accent" className="whitespace-normal break-words">
                    {skill}
                  </Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-subheadline text-text-secondary">No skills added yet.</p>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 pl-4">
          <h4 id={certificationsId} className="text-footnote font-semibold text-text-secondary">
            Certifications
          </h4>
          {handlers && can.addCertification ? (
            <Button variant="plain" onClick={handlers.onAddCertification}>
              <Plus aria-hidden="true" className="size-4.5" />
              Add certification
            </Button>
          ) : null}
        </div>
        {certifications.length > 0 ? (
          <ol
            aria-labelledby={certificationsId}
            className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
          >
            {certifications.map((certification) => (
              <CertificationRow
                key={certification.id}
                certification={certification}
                name={name}
                canEdit={can.editCertification}
                canRemove={can.removeCertification}
                handlers={handlers}
              />
            ))}
          </ol>
        ) : (
          <p className="rounded-card bg-surface px-4 py-3 text-subheadline text-text-secondary shadow-card">
            No certifications yet.
          </p>
        )}
      </div>
    </RecordSection>
  );
}

function CertificationRow({
  certification,
  name,
  canEdit,
  canRemove,
  handlers,
}: {
  certification: CertificationView;
  name: string;
  canEdit: boolean;
  canRemove: boolean;
  handlers?: DocumentHandlers;
}) {
  const [removeError, setRemoveError] = useState<string | null>(null);
  const label = `${certification.name} for ${name}`;

  async function remove() {
    setRemoveError(null);
    let failed: string | null = null;
    try {
      const result = await removeCertificationAction(null, {
        certificationId: certification.id,
        version: certification.version,
      });
      if (!result.ok) failed = result.formError ?? 'The certification wasn’t removed. Try again.';
    } catch {
      failed = 'The certification wasn’t removed. Check your connection and try again.';
    }
    if (failed) {
      setRemoveError(failed);
      // Keeps the dialog open with the error.
      throw new Error('Not removed');
    }
    handlers?.onChanged('Certification removed.');
  }

  return (
    <li className="flex flex-col gap-1 py-2.5">
      <div className="flex flex-wrap items-center gap-2 px-4">
        <span className="text-subheadline font-semibold break-words">{certification.name}</span>
        <ExpiryBadge expiry={certification.expiry} />
      </div>
      <p className="px-4 text-footnote break-words text-text-secondary">
        {certification.issuer}
        {certification.product ? ` · ${certification.product.name ?? 'Retired product'}` : null}
      </p>
      {certification.licenseNumber ? (
        <p className="px-4 text-footnote break-words text-text-secondary">
          Certificate or license number:{' '}
          <span className="numeric text-text-primary">{certification.licenseNumber}</span>
        </p>
      ) : null}
      <p className="numeric px-4 text-footnote text-text-secondary">
        Issued {formatDate(certification.issueDate)}
        {certification.expiryDate
          ? ` · Expires ${formatDate(certification.expiryDate)}`
          : ' · No expiry'}
      </p>
      {certification.addedByName ? (
        <p className="px-4 text-footnote break-words text-text-secondary">
          Added by {certification.addedByName}
        </p>
      ) : null}
      {certification.attachmentUrl || (handlers && (canEdit || canRemove)) ? (
        <div className="flex flex-wrap items-center gap-1 px-1">
          {certification.attachmentUrl ? (
            <a
              href={certification.attachmentUrl}
              aria-label={`Open the attachment of ${label}`}
              rel="noopener"
              className="inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-subheadline font-semibold text-accent hover:bg-accent-subtle"
            >
              <Paperclip aria-hidden="true" className="size-4.5" />
              Attachment
            </a>
          ) : null}
          {handlers && canEdit ? (
            <RowAction
              icon={<PencilLine aria-hidden="true" className="size-4.5" />}
              label="Edit"
              accessibleLabel={`Edit ${label}`}
              onClick={() => handlers.onEditCertification(certification)}
            />
          ) : null}
          {handlers && canRemove ? (
            <DestructiveConfirmDialog
              trigger={
                <Button
                  variant="plain"
                  aria-label={`Remove ${label}`}
                  className="px-3 text-destructive-text hover:text-destructive-text"
                >
                  <Trash2 aria-hidden="true" className="size-4.5" />
                  Remove
                </Button>
              }
              onOpenChange={(open) => {
                if (open) setRemoveError(null);
              }}
              title={`Remove ${certification.name}?`}
              description="It leaves the record, the expiry alerts and what Pulse Ops and Pulse Engage see. The change is recorded in the audit log."
              confirmLabel="Remove certification"
              onConfirm={remove}
              error={removeError}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
