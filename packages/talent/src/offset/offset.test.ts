import { describe, expect, it } from 'vitest';
import {
  creditedOffsetMinutes,
  formatSignedHours,
  holidayChangedReason,
  OFFSET_ENTRY_KINDS,
  offsetAdjustedMessage,
  offsetBalanceMinutes,
  type OffsetEntryMinutes,
  offsetReconcileDifference,
  shouldWriteOffsetCredit,
} from './entries';
import { offsetBalanceText, offsetCreditedText, offsetPendingCreditText } from './views';

// The pure offset balance rules of step 2.7 (docs/TESTING.md#timesheet-approval-dtr-and-offset-
// tests, "The offset balance" and the listener's reconcile; decisions 286, 287 and 292 in
// docs/BUILD_PLAN.md). The stored entries and the listener itself are tested on the server.

describe('the offset balance', () => {
  it('has the four kinds', () => {
    expect(OFFSET_ENTRY_KINDS).toEqual(['opening', 'credit', 'adjustment', 'usage']);
  });

  it('is the sum of the entries, and may go below zero', () => {
    expect(offsetBalanceMinutes([])).toBe(0);
    expect(offsetBalanceMinutes([{ minutes: 275 }, { minutes: 480 }, { minutes: -480 }])).toBe(275);
    expect(offsetBalanceMinutes([{ minutes: 0 }, { minutes: -60 }])).toBe(-60);
    expect(() => offsetBalanceMinutes([{ minutes: 1.5 }])).toThrow(RangeError);
  });

  it('credits an Offset timesheet even at 0 minutes, and an Overtime one never', () => {
    // D13: 120 + 155 minutes.
    expect(shouldWriteOffsetCredit(275, 'offset')).toBe(true);
    expect(shouldWriteOffsetCredit(0, 'offset')).toBe(true);
    expect(shouldWriteOffsetCredit(0, 'overtime')).toBe(false);
  });
});

describe('the holidays-changed reconcile (D14)', () => {
  const credit: OffsetEntryMinutes = { kind: 'credit', minutes: 0 };

  it('adds +480 when the holiday is confirmed, −480 when deleted, and nothing on a second run', () => {
    const entries: OffsetEntryMinutes[] = [credit];
    const confirmed = offsetReconcileDifference(480, entries);
    expect(confirmed).toBe(480);
    entries.push({ kind: 'adjustment', minutes: confirmed });
    expect(offsetReconcileDifference(480, entries)).toBe(0);
    const deleted = offsetReconcileDifference(0, entries);
    expect(deleted).toBe(-480);
    entries.push({ kind: 'adjustment', minutes: deleted });
    expect(offsetReconcileDifference(0, entries)).toBe(0);
  });

  it('counts only the timesheet’s credit and adjustments', () => {
    expect(
      creditedOffsetMinutes([
        { kind: 'credit', minutes: 275 },
        { kind: 'adjustment', minutes: 480 },
        { kind: 'usage', minutes: -120 },
        { kind: 'opening', minutes: 600 },
      ]),
    ).toBe(755);
  });

  it('words the reason and the notification', () => {
    expect(holidayChangedReason(['2026-11-30'])).toBe('Holiday changed: 2026-11-30');
    expect(holidayChangedReason(['2026-12-08', '2026-11-30', '2026-12-08'])).toBe(
      'Holiday changed: 2026-11-30, 2026-12-08',
    );
    expect(offsetAdjustedMessage(480, ['2026-11-30'])).toBe(
      'Your offset balance changed by +8.0 h: the holidays on Nov 30 changed',
    );
    expect(offsetAdjustedMessage(-480, ['2026-11-30'])).toBe(
      'Your offset balance changed by −8.0 h: the holidays on Nov 30 changed',
    );
  });
});

describe('the Offset card', () => {
  it('shows the balance, the pending credit and the credit', () => {
    expect(offsetBalanceText(750)).toBe('Balance 12.5 h');
    expect(offsetBalanceText(-60)).toBe('Balance −1.0 h');
    expect(offsetPendingCreditText(120)).toBe(
      '+2.0 h this cut-off, credited when HR approves your timesheet',
    );
    expect(offsetCreditedText({ minutes: 275, creditedOn: '2026-09-28' })).toBe(
      'Credited +4.6 h on Sep 28',
    );
    expect(formatSignedHours(0)).toBe('0.0 h');
  });
});
