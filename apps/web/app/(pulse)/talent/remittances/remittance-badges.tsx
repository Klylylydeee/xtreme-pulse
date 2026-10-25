import type { ReactNode } from 'react';
import { CircleCheck, FileText, TriangleAlert } from 'lucide-react';
import { REMITTANCE_OVERDUE_LABEL, type RemittanceStatus } from '@pulse/talent';

// Spec: docs/DESIGN_SYSTEM.md#layout--components ("Remittances on a phone": a text badge per
// agency, "Not ready" and "Ready to generate" neutral, "Generated" `accent`, "Paid" `success-text`
// with an icon, and "Overdue" `warning-text` with an icon beside any of them; color is never the
// only signal) — the remittance status badges.

type Tone = 'neutral' | 'accent' | 'success' | 'warning';

const TONES: Record<Tone, string> = {
  neutral: 'bg-bg-grouped text-text-secondary',
  accent: 'bg-accent-subtle text-accent',
  success: 'bg-bg-grouped text-success-text',
  warning: 'bg-bg-grouped text-warning-text',
};

const iconClass = 'size-3.5 shrink-0';

function Mark({ tone, icon, children }: { tone: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-footnote font-medium whitespace-nowrap ${TONES[tone]}`}
    >
      {icon}
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** An agency month's status, with "Overdue" beside it when it is. */
export function RemittanceStatusBadges({
  status,
  label,
  overdue,
}: {
  status: RemittanceStatus;
  label: string;
  overdue: boolean;
}) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {status === 'paid' ? (
        <Mark tone="success" icon={<CircleCheck aria-hidden="true" className={iconClass} />}>
          {label}
        </Mark>
      ) : status === 'generated' ? (
        <Mark tone="accent" icon={<FileText aria-hidden="true" className={iconClass} />}>
          {label}
        </Mark>
      ) : (
        <Mark tone="neutral">{label}</Mark>
      )}
      {overdue ? (
        <Mark tone="warning" icon={<TriangleAlert aria-hidden="true" className={iconClass} />}>
          {REMITTANCE_OVERDUE_LABEL}
        </Mark>
      ) : null}
    </span>
  );
}
