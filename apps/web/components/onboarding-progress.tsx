'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { cn } from '@pulse/ui';
import { ownOnboardingReminderAction } from '@/lib/actions/talent-self';
import { ONBOARDING_HREF } from '@/lib/navigation';
import {
  onboardingDoneText,
  onboardingFraction,
  onboardingPillShortText,
  onboardingPillText,
  type OnboardingReminder,
} from '@/lib/onboarding';

// Spec: docs/modules/talent.md#onboarding-checklist-and-change-requests-build-step-26 ("Reminded
// until done"; decision 261 in docs/BUILD_PLAN.md) and docs/DESIGN_SYSTEM.md#feedback--motion
// ("Onboarding progress") — the toolbar pill, before the notification bell, while any of the
// user's own onboarding items is To do: a small progress ring and "Onboarding 5 of 8" (on a phone
// the ring and "5/8", still a 44×44px target), linking to `/talent/onboarding`. Its accessible
// name is "Onboarding, 5 of 8 done". Never a modal and never in the way.
//
// The state comes from the server (`ownOnboardingReminderAction`, the signed-in user's own
// checklist, self-service), asked on the first render, on every navigation, and when an own sheet
// says something changed (`notifyOnboardingChanged`). Only the latest answer is used, and a failed
// request keeps the last good one: the pill is a reminder, never a gate. Nothing is cached.

/** The window event an own save sends, so the pill asks the server again. */
const ONBOARDING_CHANGED_EVENT = 'pulse:onboarding-changed';

/** Tells the toolbar pill the user's own onboarding may have changed. */
export function notifyOnboardingChanged(): void {
  window.dispatchEvent(new Event(ONBOARDING_CHANGED_EVENT));
}

/** The own reminder, kept current; null while unknown or for the system account. */
function useOnboardingReminder(pathname: string): OnboardingReminder | null {
  const [reminder, setReminder] = useState<OnboardingReminder | null>(null);
  const request = useRef(0);
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    const onChange = () => setChanges((count) => count + 1);
    window.addEventListener(ONBOARDING_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(ONBOARDING_CHANGED_EVENT, onChange);
  }, []);

  useEffect(() => {
    const current = ++request.current;
    ownOnboardingReminderAction(null, {})
      .then((result) => {
        if (!result.ok || current !== request.current) return;
        setReminder(result.data);
      })
      .catch(() => {
        // A reminder is a convenience: keep the last good answer and try again on the next one.
      });
  }, [pathname, changes]);

  return reminder;
}

/** A small ring showing the share done. Static: it never animates. */
function ProgressRing({ fraction }: { fraction: number }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg aria-hidden="true" viewBox="0 0 18 18" className="size-4.5 shrink-0 -rotate-90">
      <circle cx="9" cy="9" r={radius} fill="none" strokeWidth="2.5" className="stroke-separator" />
      <circle
        cx="9"
        cy="9"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        className="stroke-accent"
      />
    </svg>
  );
}

/** The toolbar pill; renders nothing once every own item is done or waiting for HR. */
export function OnboardingProgress({ pathname }: { pathname: string }) {
  const reminder = useOnboardingReminder(pathname);
  if (!reminder || !reminder.showReminder) return null;
  return (
    <Link
      href={ONBOARDING_HREF}
      aria-label={`Onboarding, ${onboardingDoneText(reminder)}`}
      aria-current={pathname === ONBOARDING_HREF ? 'page' : undefined}
      className={cn(
        'inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-full px-2.5',
        'text-footnote font-semibold text-accent hover:bg-accent-subtle/50',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      )}
    >
      <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-subtle px-2.5 py-1">
        <ProgressRing fraction={onboardingFraction(reminder)} />
        <span className="numeric hidden whitespace-nowrap md:inline">
          {onboardingPillText(reminder)}
        </span>
        <span className="numeric whitespace-nowrap md:hidden">
          {onboardingPillShortText(reminder)}
        </span>
      </span>
    </Link>
  );
}
