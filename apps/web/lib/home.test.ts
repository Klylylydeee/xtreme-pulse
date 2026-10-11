import { describe, expect, it } from 'vitest';
import {
  greetingFor,
  homeGreeting,
  manilaDaysBetween,
  manilaHourOf,
  oldestSubmittedLabel,
  upcomingHolidayWindow,
} from './home';

// Spec: docs/modules/core.md#home (decision 150 in docs/BUILD_PLAN.md) and
// docs/TESTING.md#directory-org-chart-and-command-bar-tests — the Home hero's greeting by the
// Manila time of day, and the Approvals tile's "Oldest submitted N days ago". Manila is UTC+08:00.

/** The instant at a Manila wall-clock time. */
function manila(date: string, time: string): Date {
  return new Date(`${date}T${time}+08:00`);
}

describe('the greeting', () => {
  it('reads the Manila hour, not the server’s', () => {
    // 23:30 UTC on the 11th is 07:30 on the 12th in Manila.
    expect(manilaHourOf(new Date('2026-10-11T23:30:00Z'))).toBe(7);
    expect(manilaHourOf(manila('2026-10-12', '00:00:00'))).toBe(0);
  });

  it('changes at 12:00 and 18:00 Manila time', () => {
    expect(greetingFor(manila('2026-10-12', '00:00:00'))).toBe('Good morning');
    expect(greetingFor(manila('2026-10-12', '11:59:59'))).toBe('Good morning');
    expect(greetingFor(manila('2026-10-12', '12:00:00'))).toBe('Good afternoon');
    expect(greetingFor(manila('2026-10-12', '17:59:59'))).toBe('Good afternoon');
    expect(greetingFor(manila('2026-10-12', '18:00:00'))).toBe('Good evening');
    expect(greetingFor(manila('2026-10-12', '23:59:59'))).toBe('Good evening');
  });

  it('names the user, and no one for the system account', () => {
    const at = manila('2026-10-12', '09:00:00');
    expect(homeGreeting(at, 'Ana')).toBe('Good morning, Ana');
    expect(homeGreeting(at, 'Maria Clara')).toBe('Good morning, Maria Clara');
    expect(homeGreeting(at, null)).toBe('Good morning');
    expect(homeGreeting(at, '  ')).toBe('Good morning');
  });
});

describe('the oldest waiting approval', () => {
  const reference = manila('2026-10-12', '09:00:00');

  it('counts Manila calendar days', () => {
    expect(manilaDaysBetween(manila('2026-10-12', '00:01:00'), reference)).toBe(0);
    // 23:59 the day before is one day ago, though only hours have passed.
    expect(manilaDaysBetween(manila('2026-10-11', '23:59:00'), reference)).toBe(1);
    expect(manilaDaysBetween(manila('2026-10-02', '15:00:00'), reference)).toBe(10);
    // A submit date ahead of the clock never reads as negative.
    expect(manilaDaysBetween(manila('2026-10-13', '09:00:00'), reference)).toBe(0);
  });

  it('reads "Oldest submitted N days ago"', () => {
    expect(oldestSubmittedLabel(manila('2026-10-12', '08:00:00'), reference)).toBe(
      'Oldest submitted today',
    );
    expect(oldestSubmittedLabel(manila('2026-10-11', '08:00:00'), reference)).toBe(
      'Oldest submitted 1 day ago',
    );
    expect(oldestSubmittedLabel(manila('2026-10-07', '08:00:00'), reference)).toBe(
      'Oldest submitted 5 days ago',
    );
  });
});

describe('the upcoming holidays window', () => {
  it('runs from today through 60 days ahead', () => {
    expect(upcomingHolidayWindow('2026-10-12')).toEqual({ from: '2026-10-12', to: '2026-12-11' });
  });
});
