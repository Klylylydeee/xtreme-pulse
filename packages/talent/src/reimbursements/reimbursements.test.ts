import { describe, expect, it } from 'vitest';
import type { BusinessDate } from '@pulse/core';
import { SEED_REIMBURSEMENT_SETTINGS } from '../server/payroll-settings/seed-data';
import type { EffectiveVersion } from '../timesheets/schedule';
import { type LimitLine, overLimit, overLimitByLine } from './limits';
import {
  canonicalMerchantTin,
  HEAD_OFFICE_BRANCH_CODE,
  isCanonicalMerchantTin,
  RECEIPT_NUMBER_NO_KEY_MESSAGE,
  receiptKey,
} from './receipt-key';
import {
  type ReimbursementLimit,
  type ReimbursementSettings,
  type ReimbursementType,
  reimbursementSettingsSchema,
  reimbursementTypeOf,
  removedReimbursementTypeKeys,
} from './schemas';

// The pure reimbursement tests (docs/TESTING.md#reimbursement-tests, build step 2.5, decisions
// 235–237, 242 and 250 in docs/BUILD_PLAN.md): the setting's schema, the duplicate-receipt key and
// the over-limit check. Made-up merchants and amounts only.

// ---------------------------------------------------------------------------------------------
// The setting

/** The type at `index` of a settings value (the test fails when there is none). */
function typeAt(settings: ReimbursementSettings, index: number): ReimbursementType {
  const type = settings.types[index];
  if (!type) throw new Error(`No type at ${index}.`);
  return type;
}

describe('talent.reimbursementSettings', () => {
  const valid = (): ReimbursementSettings => structuredClone(SEED_REIMBURSEMENT_SETTINGS);

  it('seeds a window of 1 and meal, transportation and other, client optional and no limit', () => {
    expect(reimbursementSettingsSchema.safeParse(SEED_REIMBURSEMENT_SETTINGS).success).toBe(true);
    expect(SEED_REIMBURSEMENT_SETTINGS.filingWindowPreviousCutOffs).toBe(1);
    expect(
      SEED_REIMBURSEMENT_SETTINGS.types.map((t) => [
        t.key,
        t.active,
        t.requiresRoute,
        t.requiresDescription,
        t.requiresClient,
        t.limit,
      ]),
    ).toEqual([
      ['meal', true, false, false, false, null],
      ['transportation', true, true, false, false, null],
      ['other', true, false, true, false, null],
    ]);
  });

  it('takes a filing window of 0 to 6 whole cut-offs', () => {
    for (const n of [0, 6]) {
      expect(
        reimbursementSettingsSchema.safeParse({ ...valid(), filingWindowPreviousCutOffs: n })
          .success,
      ).toBe(true);
    }
    for (const n of [-1, 7, 1.5, '1', null]) {
      const result = reimbursementSettingsSchema.safeParse({
        ...valid(),
        filingWindowPreviousCutOffs: n,
      });
      expect(result.success, String(n)).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['filingWindowPreviousCutOffs']);
    }
  });

  it('refuses a key used twice', () => {
    const settings = valid();
    settings.types.push({ ...typeAt(settings, 0), name: 'Meal again' });
    const result = reimbursementSettingsSchema.safeParse(settings);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['types', 3, 'key']);
  });

  it('checks the key and the name, trimming both', () => {
    const withType = (patch: object) => {
      const settings = valid();
      settings.types[0] = { ...typeAt(settings, 0), ...patch };
      return reimbursementSettingsSchema.safeParse(settings);
    };
    expect(withType({ key: ' parking ', name: ' Parking ' }).data?.types[0]).toMatchObject({
      key: 'parking',
      name: 'Parking',
    });
    for (const key of ['', 'Meal', '1meal', 'meal-allowance', 'm'.repeat(41)]) {
      expect(withType({ key }).success, key).toBe(false);
    }
    expect(withType({ name: '   ' }).success).toBe(false);
    expect(withType({ name: 'x'.repeat(101) }).success).toBe(false);
    expect(withType({ name: 'x'.repeat(100) }).success).toBe(true);
  });

  it('takes no limit, or a whole positive number of centavos per line or per day', () => {
    const withLimit = (limit: unknown) => {
      const settings = valid();
      settings.types[0] = { ...typeAt(settings, 0), limit: limit as ReimbursementLimit | null };
      return reimbursementSettingsSchema.safeParse(settings);
    };
    expect(withLimit(null).success).toBe(true);
    expect(withLimit({ amountCentavos: 50000, per: 'day' }).success).toBe(true);
    expect(withLimit({ amountCentavos: 1, per: 'line' }).success).toBe(true);
    for (const limit of [
      { amountCentavos: 0, per: 'day' },
      { amountCentavos: -100, per: 'day' },
      { amountCentavos: 500.5, per: 'day' },
      { amountCentavos: '50000', per: 'day' },
      { amountCentavos: 50000, per: 'week' },
      { amountCentavos: 50000 },
      undefined,
    ]) {
      expect(withLimit(limit).success, JSON.stringify(limit)).toBe(false);
    }
  });

  it('needs every flag as a boolean', () => {
    for (const flag of ['active', 'requiresRoute', 'requiresDescription', 'requiresClient']) {
      const settings = valid();
      settings.types[0] = { ...typeAt(settings, 0), [flag]: 'yes' };
      expect(reimbursementSettingsSchema.safeParse(settings).success, flag).toBe(false);
    }
  });

  it('lists the type keys a new version drops (keys are never removed)', () => {
    const previous = valid();
    expect(removedReimbursementTypeKeys(null, previous)).toEqual([]);
    expect(removedReimbursementTypeKeys(previous, previous)).toEqual([]);
    const inactive = valid();
    inactive.types[2] = { ...typeAt(inactive, 2), active: false };
    expect(removedReimbursementTypeKeys(previous, inactive)).toEqual([]);
    const dropped = { ...valid(), types: valid().types.filter((t) => t.key !== 'transportation') };
    expect(removedReimbursementTypeKeys(previous, dropped)).toEqual(['transportation']);
  });

  it('finds a type in a version, or null', () => {
    expect(reimbursementTypeOf(SEED_REIMBURSEMENT_SETTINGS, 'other')?.requiresDescription).toBe(
      true,
    );
    expect(reimbursementTypeOf(SEED_REIMBURSEMENT_SETTINGS, 'parking')).toBeNull();
    expect(reimbursementTypeOf(null, 'meal')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The receipt key

describe('the canonical merchant TIN', () => {
  it('gives a 9-digit TIN the head office branch 00000', () => {
    expect(HEAD_OFFICE_BRANCH_CODE).toBe('00000');
    expect(canonicalMerchantTin('123456789')).toBe('12345678900000');
    expect(canonicalMerchantTin('123-456-789')).toBe('12345678900000');
  });

  it('pads a 12-digit TIN’s 3-digit branch code to 5', () => {
    expect(canonicalMerchantTin('123-456-789-001')).toBe('12345678900001');
    expect(canonicalMerchantTin('123 456 789 001')).toBe('12345678900001');
    expect(canonicalMerchantTin('123456789000')).toBe('12345678900000');
  });

  it('keeps a 14-digit TIN', () => {
    expect(canonicalMerchantTin('12345678900001')).toBe('12345678900001');
    expect(canonicalMerchantTin('123-456-789-00123')).toBe('12345678900123');
  });

  it('matches the 12-digit and 14-digit forms of one branch, and 9 digits against branch 00000', () => {
    expect(canonicalMerchantTin('123456789001')).toBe(canonicalMerchantTin('12345678900001'));
    expect(canonicalMerchantTin('123456789')).toBe(canonicalMerchantTin('123-456-789-00000'));
    // Branches are part of the key.
    expect(canonicalMerchantTin('123456789001')).not.toBe(canonicalMerchantTin('123456789'));
  });

  it('refuses anything other than 9, 12 or 14 digits', () => {
    for (const tin of [
      '',
      '12345678',
      '1234567890',
      '1234567890123',
      '123456789012345',
      '12345678A',
      '123.456.789',
      '123/456/789',
    ]) {
      expect(canonicalMerchantTin(tin), tin).toBeNull();
    }
  });

  it('recognises only the canonical 14 digits', () => {
    expect(isCanonicalMerchantTin('12345678900001')).toBe(true);
    expect(isCanonicalMerchantTin('123456789')).toBe(false);
    expect(isCanonicalMerchantTin('123-456-789-00001')).toBe(false);
    expect(isCanonicalMerchantTin('1234567890000A')).toBe(false);
  });
});

describe('the receipt key', () => {
  it('ignores case, separators and leading zeros', () => {
    expect(receiptKey('or-000123')).toBe('OR123');
    expect(receiptKey('OR 123')).toBe('OR123');
    expect(receiptKey('Or123')).toBe('OR123');
    expect(receiptKey(' SI#  0042 ')).toBe('SI42');
    expect(receiptKey('000123')).toBe('123');
    expect(receiptKey('123')).toBe('123');
  });

  it('keeps one zero of an all-zero number, and the zeros inside a number', () => {
    expect(receiptKey('0000')).toBe('0');
    expect(receiptKey('OR-0')).toBe('OR0');
    expect(receiptKey('INV-1002')).toBe('INV1002');
    expect(receiptKey('2026-0001')).toBe('20260001');
  });

  it('refuses a number with no letter or digit', () => {
    for (const value of ['', '   ', '--', '#/.']) expect(receiptKey(value), value).toBeNull();
    expect(RECEIPT_NUMBER_NO_KEY_MESSAGE.length).toBeGreaterThan(0);
  });

  it('tells different numbers apart', () => {
    expect(receiptKey('OR-123')).not.toBe(receiptKey('OR-1230'));
    expect(receiptKey('SI-123')).not.toBe(receiptKey('OR-123'));
  });
});

// ---------------------------------------------------------------------------------------------
// Limits

/** The seeded types with the meal limit set (from 2000-01-01), and a version without it. */
function versionsWith(
  limit: ReimbursementLimit | null,
  from: BusinessDate = '2000-01-01',
): EffectiveVersion<ReimbursementSettings>[] {
  const versions: EffectiveVersion<ReimbursementSettings>[] = [];
  if (from !== '2000-01-01') {
    versions.push({ effectiveFrom: '2000-01-01', value: SEED_REIMBURSEMENT_SETTINGS });
  }
  versions.push({
    effectiveFrom: from,
    value: {
      ...SEED_REIMBURSEMENT_SETTINGS,
      types: SEED_REIMBURSEMENT_SETTINGS.types.map((type) =>
        type.key === 'meal' ? { ...type, limit } : type,
      ),
    },
  });
  return versions;
}

let lineIds = 0;
function line(
  amountCentavos: number,
  receiptDate: BusinessDate = '2026-09-14',
  patch: Partial<LimitLine> = {},
): LimitLine {
  lineIds += 1;
  return { id: `r${lineIds}`, typeKey: 'meal', receiptDate, amountCentavos, ...patch };
}

describe('over-limit lines', () => {
  const perDay = versionsWith({ amountCentavos: 50000, per: 'day' });
  const perLine = versionsWith({ amountCentavos: 50000, per: 'line' });

  it('flags both lines of ₱300.00 and ₱250.00 on one day, on two timesheets, ₱50.00 over a ₱500.00 daily limit', () => {
    // Two timesheets' lines: the employee's lines across every timesheet are passed together.
    const onThisTimesheet = line(30000);
    const onAnother = line(25000);
    const result = overLimitByLine([onThisTimesheet], perDay, [onAnother]);
    expect(result.get(onThisTimesheet.id)).toEqual({
      limitCentavos: 50000,
      per: 'day',
      excessCentavos: 5000,
    });
    expect(overLimit(onAnother, perDay, [onThisTimesheet])).toEqual({
      limitCentavos: 50000,
      per: 'day',
      excessCentavos: 5000,
    });
  });

  it('with a limit per line, flags only a line over ₱500.00', () => {
    const over = line(50001);
    const lines = [line(30000), line(25000), line(50000), over];
    const result = overLimitByLine(lines, perLine);
    expect([...result.keys()]).toEqual([over.id]);
    expect(result.get(over.id)).toEqual({
      limitCentavos: 50000,
      per: 'line',
      excessCentavos: 1,
    });
  });

  it('doesn’t flag a day exactly at the limit', () => {
    const lines = [line(30000), line(20000)];
    expect(overLimitByLine(lines, perDay).size).toBe(0);
  });

  it('adds up only live lines of that type on that receipt date', () => {
    const mine = line(40000);
    const others = [
      line(20000, '2026-09-14', { deletedAt: new Date('2026-09-14T09:00:00+08:00') }),
      line(20000, '2026-09-13'),
      line(20000, '2026-09-14', { typeKey: 'transportation' }),
    ];
    expect(overLimit(mine, perDay, others)).toBeNull();
    // A deleted line itself is never flagged.
    const deleted = line(90000, '2026-09-14', { deletedAt: new Date() });
    expect(overLimit(deleted, perDay)).toBeNull();
    expect(overLimit(deleted, perLine)).toBeNull();
  });

  it('counts the line once, whether or not it is in the list, and takes its newest amount', () => {
    const saved = line(30000);
    expect(overLimit(saved, perDay, [saved])).toBeNull();
    // The line being edited (in `lines`) replaces its stored copy (in `employeeLines`).
    const edited = { ...saved, amountCentavos: 60000 };
    const result = overLimitByLine([edited], perDay, [saved]);
    expect(result.get(saved.id)?.excessCentavos).toBe(10000);
  });

  it('uses the version in effect on the receipt date', () => {
    const fromSeptember = versionsWith({ amountCentavos: 50000, per: 'line' }, '2026-09-01');
    expect(overLimit(line(60000, '2026-08-31'), fromSeptember)).toBeNull();
    expect(overLimit(line(60000, '2026-09-01'), fromSeptember)?.excessCentavos).toBe(10000);
    // The order of the versions doesn't matter.
    expect(overLimit(line(60000, '2026-09-01'), [...fromSeptember].reverse())?.excessCentavos).toBe(
      10000,
    );
  });

  it('flags nothing with no limit, no version, or a type missing from the version', () => {
    expect(overLimit(line(9_999_999), versionsWith(null))).toBeNull();
    expect(overLimit(line(9_999_999, '1999-12-31'), perLine)).toBeNull();
    expect(overLimit(line(9_999_999, '2026-09-14', { typeKey: 'parking' }), perLine)).toBeNull();
    expect(overLimit(line(9_999_999), [])).toBeNull();
  });

  it('refuses amounts that aren’t whole centavos', () => {
    expect(() => overLimit(line(500.5), perLine)).toThrow(RangeError);
    expect(() => overLimit(line(30000), perDay, [line(100.25)])).toThrow(RangeError);
  });
});
