import { useId } from 'react';
import { CalendarHeart, Clock, Info, Stethoscope, TreePalm, type LucideIcon } from 'lucide-react';
import {
  formatDayCount,
  formatHours,
  leaveBalanceLines,
  type LeaveBalancesView,
  type OffsetAvailableBalanceView,
  offsetAvailableText,
  regularizationMissingText,
} from '@pulse/talent';
import { IconTile } from '@pulse/ui/components/icon-tile';

// Spec: docs/DESIGN_SYSTEM.md#layout--components ("Time off on a phone": balance cards) and
// docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28 ("Screens") —
// one `surface` card per balance (VL, SL, Offset), each with a tinted icon tile, the balance in
// Display size with its unit as text ("4.5 days", "12.5 h"), and "Available 3.5 days" under it
// when a pending request holds some. On a phone the cards scroll as a row inside the page, never
// wider than it; from the small breakpoint they sit in a grid. The `perYear` types used this year
// sit under them as a grouped list ("Solo parent leave · 2 of 7 days used"). A confidential type
// never reaches here for anyone who may not see it (the service leaves it out).

const CARD_ICONS: Record<string, LucideIcon> = {
  vacation: TreePalm,
  sick: Stethoscope,
};

function BalanceCard({
  name,
  shortName,
  Icon,
  value,
  available,
  negative,
}: {
  name: string;
  shortName: string;
  Icon: LucideIcon;
  value: string;
  available: string | null;
  negative: boolean;
}) {
  const [figure, ...rest] = value.split(' ');
  const unit = rest.join(' ');
  return (
    <li className="flex w-44 shrink-0 snap-start flex-col gap-3 rounded-card bg-surface p-4 shadow-card sm:w-auto">
      <div className="flex items-center gap-2.5">
        <IconTile className="size-9">
          <Icon className="size-5" strokeWidth={1.75} />
        </IconTile>
        <span className="flex min-w-0 flex-col">
          <span className="text-subheadline font-semibold">{shortName}</span>
          <span className="truncate text-footnote text-text-secondary">{name}</span>
        </span>
      </div>
      <span className="flex flex-col gap-0.5">
        {/* The figure in Display size, its unit as text beside it ("4.5 days"). */}
        <span className={negative ? 'text-destructive-text' : undefined}>
          <span className="text-display numeric">{figure}</span>
          {unit ? <span className="ml-1 text-subheadline font-semibold">{unit}</span> : null}
        </span>
        {available ? (
          <span className="text-footnote text-text-secondary numeric">{available}</span>
        ) : null}
      </span>
    </li>
  );
}

export function BalanceCards({
  balances,
  offset,
}: {
  balances: LeaveBalancesView | null;
  offset: OffsetAvailableBalanceView | null;
}) {
  const titleId = useId();
  const perYearId = useId();
  const cards = balances?.balances ?? [];
  const perYear = balances?.perYear ?? [];
  if (cards.length === 0 && !offset && perYear.length === 0) return null;
  return (
    <section aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <h2 id={titleId} className="px-1 text-headline">
        Balances
      </h2>
      <ul
        className="-mx-1 flex snap-x snap-mandatory gap-3 overflow-x-auto px-1 pb-1 sm:mx-0 sm:grid sm:grid-cols-3 sm:overflow-visible sm:px-0"
        // The row scrolls on its own on a phone; the page never does.
        tabIndex={0}
        aria-label="Balance cards"
      >
        {cards.map((balance) => {
          const lines = leaveBalanceLines(balance);
          return (
            <BalanceCard
              key={balance.typeKey}
              name={balance.name}
              shortName={balance.shortName}
              Icon={CARD_ICONS[balance.typeKey] ?? CalendarHeart}
              value={lines.balance}
              available={lines.available}
              negative={balance.balanceHalfDays < 0}
            />
          );
        })}
        {offset ? (
          <BalanceCard
            name="Offset hours"
            shortName="Offset"
            Icon={Clock}
            value={`${offset.balanceMinutes < 0 ? '−' : ''}${formatHours(Math.abs(offset.balanceMinutes))}`}
            available={offsetAvailableText(offset)}
            negative={offset.balanceMinutes < 0}
          />
        ) : null}
      </ul>
      {balances?.regularizationDateMissing ? (
        <p className="flex items-start gap-2 px-1 text-footnote text-warning-text">
          <Info aria-hidden="true" className="mt-px size-4 shrink-0" />
          <span>
            {regularizationMissingText(cards.map((balance) => balance.shortName))}. Ask HR.
          </span>
        </p>
      ) : null}
      {perYear.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 id={perYearId} className="px-4 text-footnote font-semibold text-text-secondary">
            Used this year
          </h3>
          <ul
            aria-labelledby={perYearId}
            className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
          >
            {perYear.map((usage) => (
              <li
                key={usage.typeKey}
                className="flex min-h-11 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-4 py-2.5"
              >
                <span className="text-subheadline">{usage.name}</span>
                <span className="text-footnote text-text-secondary numeric">
                  {formatDayCount(usage.usedHalfDays).replace(/ days?$/, '')} of{' '}
                  {formatDayCount(usage.limitHalfDays)} used in {usage.year}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
