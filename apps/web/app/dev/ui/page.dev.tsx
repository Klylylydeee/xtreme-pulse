import type { Metadata } from 'next';
import { Suspense, type ReactNode } from 'react';
import {
  COLOR_TOKENS,
  EASING_TOKENS,
  GLASS_TOKENS,
  GLASS_VALUE_TOKENS,
  MOTION_TOKENS,
  RADIUS_TOKENS,
  SHADOW_TOKENS,
  SPACING_STEPS,
  TYPE_STYLES,
} from '@pulse/ui';
import { Inbox } from 'lucide-react';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { ErrorState } from '@pulse/ui/components/error-state';
import { Skeleton } from '@pulse/ui/components/skeleton';
import {
  ButtonsDemo,
  ConfirmDialogDemo,
  FormStatesDemo,
  SegmentedControlDemo,
  SheetFormDemo,
  ShortcutHintsDemo,
} from './gallery-controls';
import { ChartDemo, DataTableDemo } from './gallery-data';
import { MaskedFieldDemo } from './masked-field-demo';
import { NotificationBellDemo } from './gallery-notifications';
import { AppearanceStatus, TokenValue } from './token-value';

export const metadata: Metadata = {
  title: 'Design system',
};

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: ReactNode;
  children: ReactNode;
}) {
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <section className="flex flex-col gap-3" aria-labelledby={id}>
      <div className="flex flex-col gap-1 px-1">
        <h2 id={id} className="text-title-3">
          {title}
        </h2>
        {note ? <p className="text-subheadline text-text-secondary">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

export default function DevUiPage() {
  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-8 sm:px-8">
      <header className="flex flex-col gap-2">
        <p className="text-footnote text-text-secondary">Development only</p>
        <h1 className="text-display">Design system</h1>
        <p className="text-callout text-text-secondary">
          Every token and shared component of the Cobalt design system. Light and dark follow your
          operating system setting.
        </p>
        <p className="text-subheadline text-accent">
          <AppearanceStatus />
        </p>
      </header>

      <Section title="Color" note="Cobalt palette. Values update when the OS appearance changes.">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {COLOR_TOKENS.map((token) => (
            <li
              key={token.name}
              className="flex items-center gap-3 rounded-card bg-surface p-3 shadow-card"
            >
              <span
                aria-hidden="true"
                className="size-12 shrink-0 rounded-control border border-separator"
                style={{ backgroundColor: `var(--${token.name})` }}
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-headline">{token.name}</span>
                <span className="text-footnote text-text-secondary">{token.use}</span>
                <TokenValue name={token.name} />
              </span>
            </li>
          ))}
        </ul>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-3xl bg-hero p-6 shadow-accent">
            <p className="text-title-2 text-hero-text">Hero area</p>
            <p className="text-subheadline text-hero-text-secondary">
              Supporting text on the solid cobalt hero.
            </p>
          </div>
          <div className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
            <p className="text-subheadline">Status text and dots</p>
            <ul className="flex flex-col gap-2 text-subheadline">
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="size-2 rounded-full bg-success" />
                <span className="text-success-text">Approved</span>
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="size-2 rounded-full bg-warning" />
                <span className="text-warning-text">Pending</span>
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden="true" className="size-2 rounded-full bg-destructive" />
                <span className="text-destructive-text">Error</span>
              </li>
            </ul>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-control bg-accent px-3 py-1 text-subheadline text-accent-text">
                On accent
              </span>
              <span className="rounded-control bg-accent-subtle px-3 py-1 text-subheadline text-accent">
                Accent subtle
              </span>
              <span className="rounded-control bg-destructive-text px-3 py-1 text-subheadline text-on-semantic-text">
                On destructive
              </span>
            </div>
          </div>
        </div>
      </Section>

      <Section
        title="Typography"
        note={
          <>
            Apple text styles in rem. Font stack: <TokenValue name="font-sans" />
          </>
        }
      >
        <ul className="flex flex-col divide-y divide-separator rounded-card bg-surface shadow-card">
          {TYPE_STYLES.map((style) => (
            <li
              key={style.token}
              className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-6"
            >
              <span className="w-40 shrink-0 text-footnote text-text-secondary">
                {style.name} · <TokenValue name={style.token} />
              </span>
              <span className={`${style.className} min-w-0 break-words`}>
                {style.name}: Payroll run 2026-09 · ₱48,250.00
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Spacing"
        note={
          <>
            Grid step (--spacing): <TokenValue name="spacing" />
          </>
        }
      >
        <ul className="flex flex-col gap-2 rounded-card bg-surface p-4 shadow-card">
          {SPACING_STEPS.map((step) => (
            <li key={step} className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-footnote text-text-secondary numeric">
                × {step}
              </span>
              <span
                aria-hidden="true"
                className="h-3 rounded-sm bg-accent"
                style={{ width: `calc(var(--spacing) * ${step})` }}
              />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Radii">
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {RADIUS_TOKENS.map((radius) => (
            <li
              key={radius.token}
              className={`${radius.className} flex h-24 flex-col justify-end border border-separator bg-surface p-3`}
            >
              <span className="text-subheadline">{radius.use}</span>
              <TokenValue name={radius.token} />
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Shadows" note="On floating layers only.">
        <ul className="grid grid-cols-1 gap-6 sm:grid-cols-3">
          {SHADOW_TOKENS.map((shadow) => (
            <li
              key={shadow.token}
              className={`${shadow.className} flex h-24 flex-col justify-end rounded-card bg-surface p-3`}
            >
              <span className="text-headline">{shadow.token}</span>
              <span className="text-footnote text-text-secondary">{shadow.use}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Glass"
        note={
          <>
            {GLASS_VALUE_TOKENS.map((token) => (
              <span key={token} className="mr-3 inline-flex gap-1">
                {token}: <TokenValue name={token} />
              </span>
            ))}
            Solid with reduced transparency or without backdrop-filter.
          </>
        }
      >
        <div className="relative overflow-hidden rounded-card bg-bg-grouped p-4 sm:p-6">
          <div aria-hidden="true" className="absolute inset-0 flex flex-wrap gap-4 p-4">
            {Array.from({ length: 24 }, (_, index) => (
              <span
                key={index}
                className={`size-12 rounded-full ${index % 3 === 0 ? 'bg-hero' : index % 3 === 1 ? 'bg-accent' : 'bg-warning'}`}
              />
            ))}
          </div>
          <div className="relative grid grid-cols-1 gap-4 sm:grid-cols-2">
            {GLASS_TOKENS.map((glass) => (
              <div
                key={glass.token}
                className={`${glass.className} flex flex-col gap-1 rounded-panel p-4 shadow-float`}
              >
                <span className="text-headline">{glass.token}</span>
                <span className="text-subheadline text-text-secondary">{glass.use}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section title="Motion" note="Hover or focus a tile. Off with reduced motion.">
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {MOTION_TOKENS.map((motion) => (
            <li key={motion.token}>
              <button
                type="button"
                className={`${motion.className} flex min-h-11 w-full flex-col items-start gap-1 rounded-card bg-surface p-4 text-left shadow-card transition-[transform,box-shadow] ease-out hover:-translate-y-1 hover:shadow-float focus-visible:-translate-y-1`}
              >
                <span className="text-headline">{motion.token}</span>
                <TokenValue name={motion.token} />
              </button>
            </li>
          ))}
          {EASING_TOKENS.map((easing) => (
            <li
              key={easing.token}
              className="flex flex-col gap-1 rounded-card bg-surface p-4 shadow-card"
            >
              <span className="text-headline">{easing.token}</span>
              <span className="text-footnote text-text-secondary">{easing.use}</span>
              <TokenValue name={easing.token} />
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Buttons"
        note="Every control is at least 44×44px. Destructive buttons use the destructive-text fill."
      >
        <ButtonsDemo />
      </Section>

      <Section
        title="Shortcut hints"
        note="Shown for your platform: ⌘ on Apple devices, Ctrl elsewhere."
      >
        <ShortcutHintsDemo />
      </Section>

      <Section
        title="Segmented control"
        note="Tab into a control, then use the arrow keys and Space or Enter."
      >
        <SegmentedControlDemo />
      </Section>

      <Section
        title="Sheet and form"
        note="Create and edit flows open in a sheet. Submit empty to see inline validation; ⌘↵ / Ctrl+Enter submits, Escape closes. Full screen on phones."
      >
        <SheetFormDemo />
      </Section>

      <Section title="Inset grouped form sections" note="Every field state.">
        <FormStatesDemo />
      </Section>

      <Section
        title="Data table and inspector panel"
        note="Sort by the column headers. Click a row, or Tab to it and press Enter, to open the inspector (a full-height sheet below the lg breakpoint). Phones show the rows as a list."
      >
        <DataTableDemo />
      </Section>

      <Section
        title="Charts"
        note="Recharts in the chart wrapper, which requires an accessible name. Accent for the main series, direct labels."
      >
        <ChartDemo />
      </Section>

      <Section
        title="Masked field"
        note="Sensitive values show their last 4 characters. Reveal fetches the full value from the server; Hide forgets it."
      >
        <div className="max-w-xl">
          <Suspense fallback={<Skeleton className="h-24 w-full rounded-card" />}>
            <MaskedFieldDemo />
          </Suspense>
        </div>
      </Section>

      <Section
        title="Notifications bell"
        note="The unread badge uses the accent colour, hides at 0 and caps at 99+. Inside a popover, empty states use the inline variant (no card)."
      >
        <NotificationBellDemo />
      </Section>

      <Section
        title="Destructive confirm dialog"
        note="Focus starts on Cancel; the confirm button names the action."
      >
        <ConfirmDialogDemo />
      </Section>

      <Section title="Loading, empty and error states" note="From step 0.3, on every screen.">
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="flex flex-col gap-3 rounded-card bg-surface p-6 shadow-card">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <EmptyState
            icon={<Inbox strokeWidth={1.75} />}
            title="Nothing here yet"
            description="One line on what this is and what to do next."
            action={<Button variant="tinted">One action</Button>}
          />
          <ErrorState
            title="This couldn’t load"
            description="Say what to do next."
            action={<Button>Try again</Button>}
          />
        </div>
      </Section>
    </main>
  );
}
