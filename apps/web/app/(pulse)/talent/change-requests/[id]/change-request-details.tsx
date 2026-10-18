'use client';

import { useId } from 'react';
import Link from 'next/link';
import { ListChecks } from 'lucide-react';
import { formatDate, formatDateTime } from '@pulse/core';
import {
  type ChangeRequestFieldView,
  type ChangeRequestStatus,
  type ChangeRequestView,
  formatPagibigMid,
  formatPhilhealthPin,
  formatSssNumber,
  formatTin,
  type MaskedDigitsView,
} from '@pulse/talent';
import { cn } from '@pulse/ui';
import { buttonVariants } from '@pulse/ui/components/button';
import { MaskedField, type MaskedFieldRevealResult } from '@pulse/ui/components/masked-field';
import { Badge } from '@/components/org-structure';
import { revealSensitiveAction } from '@/lib/actions/sensitive';
import { RecordCard, Row } from '../../record-ui';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Screens":
// `/talent/change-requests/<id>`) and docs/DESIGN_SYSTEM.md#layout--components — the request's
// details in inset grouped cards: who and what, then one card per changed field with Current and
// Proposed (Previous and Applied once approved). The status badge carries text, so color is never
// the only signal. A masked value shows its last 4 digits until revealed; each reveal goes back to
// the server, which checks access and writes the audit entry. Read-only: deciding stays on
// Approvals.

const STATUS_TONES: Record<ChangeRequestStatus, 'accent' | 'neutral'> = {
  pending: 'accent',
  returned: 'neutral',
  approved: 'neutral',
  rejected: 'neutral',
  cancelled: 'neutral',
};

/** How a revealed value is shown, by field. */
const REVEAL_FORMATS: Record<string, (digits: string) => string> = {
  tin: formatTin,
  sss: formatSssNumber,
  philhealth: formatPhilhealthPin,
  pagibig: formatPagibigMid,
};

function revealOf(target: MaskedDigitsView, field: string) {
  const format = REVEAL_FORMATS[field] ?? ((digits: string) => digits);
  return async (): Promise<MaskedFieldRevealResult> => {
    const result = await revealSensitiveAction(null, {
      ownerType: target.ownerType,
      ownerId: target.ownerId,
      field: target.field,
    });
    return result.ok
      ? { ok: true, data: format(result.data) }
      : { ok: false, formError: result.formError };
  };
}

export function ChangeRequestDetails({ view }: { view: ChangeRequestView }) {
  const approved = view.status === 'approved';
  const fieldsId = useId();
  return (
    <div className="flex w-full max-w-2xl flex-col gap-5">
      <RecordCard>
        <Row term="Employee">
          {view.employee.name}
          {view.employee.employeeNumber ? (
            <span className="numeric text-text-secondary"> · {view.employee.employeeNumber}</span>
          ) : null}
        </Row>
        <Row term="Section">{view.sectionLabel}</Row>
        <Row term="Status">
          <Badge tone={STATUS_TONES[view.status]}>{view.statusLabel}</Badge>
        </Row>
        <Row term="Sent">
          <span className="numeric">{formatDateTime(view.sentAt)}</span>
        </Row>
        {view.note ? <Row term="Note from the employee">{view.note}</Row> : null}
        {view.decided ? (
          <Row term={approved ? 'Approved by' : 'Decided by'}>
            {view.decided.byName}
            <span className="numeric text-text-secondary"> · {formatDate(view.decided.at)}</span>
          </Row>
        ) : null}
        {view.remarks ? <Row term="Remarks">{view.remarks}</Row> : null}
      </RecordCard>

      <section aria-labelledby={fieldsId} className="flex flex-col gap-3">
        <h2 id={fieldsId} className="pl-4 text-footnote font-semibold text-text-secondary">
          {approved ? 'What changed' : 'Changes'}
        </h2>
        {view.fields.map((field) => (
          <FieldCard key={field.field} field={field} approved={approved} />
        ))}
        {!approved && view.status === 'pending' ? (
          <p className="px-4 text-footnote text-text-secondary">
            Current values are the record as it is now. An approval writes the proposed values.
          </p>
        ) : null}
      </section>

      <Link
        href={view.approvalHref}
        className={cn(buttonVariants({ variant: 'tinted' }), 'self-start')}
      >
        <ListChecks aria-hidden="true" className="size-4.5" strokeWidth={1.75} />
        Open in Approvals
      </Link>
    </div>
  );
}

function FieldCard({ field, approved }: { field: ChangeRequestFieldView; approved: boolean }) {
  const titleId = useId();
  const before = approved ? 'Previous' : 'Current';
  const after = approved ? 'Applied' : 'Proposed';
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3 id={titleId} className="pl-4 text-footnote font-semibold text-text-secondary">
        {field.label}
      </h3>
      <RecordCard>
        {field.sensitive ? (
          <>
            <MaskedValue term={before} value={field.currentMasked ?? null} field={field.field} />
            <MaskedValue term={after} value={field.proposedMasked ?? null} field={field.field} />
          </>
        ) : (
          <>
            <Row term={before}>{field.current}</Row>
            <Row term={after}>{field.proposed}</Row>
          </>
        )}
      </RecordCard>
    </section>
  );
}

function MaskedValue({
  term,
  value,
  field,
}: {
  term: string;
  value: MaskedDigitsView | null;
  field: string;
}) {
  if (!value) return <Row term={term} />;
  return <MaskedField label={term} lastFour={value.lastFour} reveal={revealOf(value, field)} />;
}
