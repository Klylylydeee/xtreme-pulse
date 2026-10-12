import { describe, expect, it } from 'vitest';
import { addMonths, probationEndDate } from './derived';
import { WORK_REGIONS } from './fixed-sets';
import {
  formatMobileNumber,
  formatPagibigMid,
  formatPhilhealthPin,
  formatSssNumber,
  formatTin,
  isBankAccountNumber,
  isTin,
  normalizeDigits,
} from './formats';
import {
  bankAccountSectionSchema,
  compensationEntryFormSchema,
  compensationEntrySchema,
  employmentSectionSchema,
  governmentIdsSectionSchema,
  personalSectionSchema,
} from './validation';

// The formats and form schemas (docs/modules/talent.md#the-employee-record-build-step-21,
// docs/TESTING.md#employee-record-tests). Made-up numbers only.

const EMPLOYEE = '65f0c0ffee0000000000abcd';

describe('ID formats', () => {
  it('accepts each ID’s digit counts and shows it formatted, leading zeros kept', () => {
    expect(formatTin('001234567')).toBe('001-234-567');
    expect(formatTin('001234567000')).toBe('001-234-567-000');
    expect(formatTin('00123456700000')).toBe('001-234-567-00000');
    expect(isTin('0012345670')).toBe(false);
    expect(formatSssNumber('0412345678')).toBe('04-1234567-8');
    expect(formatPhilhealthPin('010000000012')).toBe('01-000000001-2');
    expect(formatPagibigMid('001200340056')).toBe('0012-0034-0056');
    expect(formatMobileNumber('09171234567')).toBe('0917 123 4567');
    expect(isBankAccountNumber('000000001')).toBe(false);
    expect(isBankAccountNumber('0000000001')).toBe(true);
    expect(isBankAccountNumber('0000000000000001')).toBe(true);
    expect(isBankAccountNumber('00000000000000001')).toBe(false);
    expect(normalizeDigits(' 001-234 567 ')).toBe('001234567');
  });

  it('parses IDs to digit strings and refuses the wrong counts', () => {
    const parsed = governmentIdsSectionSchema.parse({
      employeeId: EMPLOYEE,
      version: '3',
      tin: '001-234-567-000',
      rdoCode: '043',
      sss: '04-1234567-8',
      philhealth: '01-000000001-2',
      pagibig: '0012 0034 0056',
    });
    expect(parsed).toEqual({
      employeeId: EMPLOYEE,
      version: 3,
      tin: '001234567000',
      rdoCode: '043',
      sss: '0412345678',
      philhealth: '010000000012',
      pagibig: '001200340056',
    });
    // Idempotent: the service parses the action's output again.
    expect(governmentIdsSectionSchema.parse(parsed)).toEqual(parsed);

    for (const [field, value] of [
      ['tin', '0012345670'],
      ['sss', '041234567'],
      ['philhealth', '0100000000123'],
      ['pagibig', '00120034005'],
      ['rdoCode', '43'],
      ['tin', '00123456A'],
    ]) {
      const result = governmentIdsSectionSchema.safeParse({
        employeeId: EMPLOYEE,
        version: '0',
        rdoCode: '',
        [field as string]: value,
      });
      expect(result.success).toBe(false);
      // The message never repeats what was typed.
      expect(JSON.stringify(result.error?.issues.map((i) => i.message))).not.toContain(value);
    }
  });

  it('reads an empty sensitive input as "keep the stored value"', () => {
    const parsed = governmentIdsSectionSchema.parse({
      employeeId: EMPLOYEE,
      version: '1',
      tin: '',
      rdoCode: '',
      sss: '   ',
    });
    expect(parsed.tin).toBeUndefined();
    expect(parsed.sss).toBeUndefined();
    expect(parsed.philhealth).toBeUndefined();
    expect(parsed.rdoCode).toBeNull();
    const bank = bankAccountSectionSchema.parse({
      employeeId: EMPLOYEE,
      version: '1',
      bank: 'unionbank',
      accountNumber: '',
      accountName: ' Sample Name ',
    });
    expect(bank.accountNumber).toBeUndefined();
    expect(bank.accountName).toBe('Sample Name');
    expect(bankAccountSectionSchema.safeParse({ ...bank, bank: 'bdo' }).success).toBe(false);
  });
});

describe('form schemas', () => {
  it('keeps the date of birth and civil status only when sent', () => {
    const base = {
      employeeId: EMPLOYEE,
      version: '0',
      sex: '',
      nationality: '',
      presentAddress: '',
      permanentAddress: '',
      mobileNumber: '0917-123-4567',
      personalEmail: 'Someone@Example.com',
      emergencyContactName: '',
      emergencyContactRelationship: '',
      emergencyContactMobile: '',
    };
    const without = personalSectionSchema.parse(base);
    expect(without.dateOfBirth).toBeUndefined();
    expect(without.civilStatus).toBeUndefined();
    expect(without.mobileNumber).toBe('09171234567');
    expect(without.personalEmail).toBe('someone@example.com');
    expect(without.sex).toBeNull();

    const cleared = personalSectionSchema.parse({ ...base, dateOfBirth: '', civilStatus: '' });
    expect(cleared.dateOfBirth).toBeNull();
    expect(cleared.civilStatus).toBeNull();
    const set = personalSectionSchema.parse({
      ...base,
      dateOfBirth: '1990-02-28',
      civilStatus: 'single',
    });
    expect(set.dateOfBirth).toBe('1990-02-28');
    expect(personalSectionSchema.parse(set)).toEqual(set);
    expect(personalSectionSchema.safeParse({ ...base, mobileNumber: '08171234567' }).success).toBe(
      false,
    );
  });

  it('takes the 18 work regions, NCR first', () => {
    expect(WORK_REGIONS).toHaveLength(18);
    expect(WORK_REGIONS[0]).toBe('NCR');
    const parsed = employmentSectionSchema.parse({
      employeeId: EMPLOYEE,
      version: '2',
      workRegion: 'NIR',
      contractEndDate: '',
      regularizationDate: '2024-07-01',
      separationRemarks: '',
    });
    expect(parsed).toEqual({
      employeeId: EMPLOYEE,
      version: 2,
      workRegion: 'NIR',
      contractEndDate: null,
      regularizationDate: '2024-07-01',
      separationRemarks: null,
    });
    expect(employmentSectionSchema.safeParse({ ...parsed, workRegion: 'IV-B' }).success).toBe(
      false,
    );
  });

  it('parses pesos to whole centavos without floating point', () => {
    const parse = (basicSalary: string) =>
      compensationEntryFormSchema.parse({
        employeeId: EMPLOYEE,
        effectiveDate: '2024-01-01',
        basicSalary,
        rateType: 'monthly',
        reason: 'Starting salary',
      }).basicSalaryCentavos;
    // 0.1 + 0.2 and 1.005 are where floating point goes wrong.
    expect(parse('0.30')).toBe(30);
    expect(parse('1.01')).toBe(101);
    expect(parse('20,000.07')).toBe(2000007);
    expect(parse('₱ 610.00')).toBe(61000);
    expect(parse('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parse('1.005')).toThrow();
    expect(() => parse('abc')).toThrow();

    const values = compensationEntryFormSchema.parse({
      employeeId: EMPLOYEE,
      effectiveDate: '2024-01-01',
      basicSalary: '1,000',
      rateType: 'daily',
      minimumWageEarner: 'on',
      reason: '  Starting salary  ',
    });
    expect(values).toEqual({
      employeeId: EMPLOYEE,
      effectiveDate: '2024-01-01',
      basicSalaryCentavos: 100000,
      rateType: 'daily',
      minimumWageEarner: true,
      reason: 'Starting salary',
      // Step 2.3: "Save anyway" on the minimum wage warning, off unless the form sends it.
      allowBelowMinimumWage: false,
    });
    expect(compensationEntrySchema.parse(values)).toEqual(values);
    expect(
      compensationEntrySchema.safeParse({ ...values, basicSalaryCentavos: 10.5 }).success,
    ).toBe(false);
    expect(compensationEntrySchema.safeParse({ ...values, reason: '' }).success).toBe(false);
  });
});

describe('derived values', () => {
  it('shows the probation end as the date hired + 6 months while Probationary', () => {
    expect(probationEndDate('Probationary', '2024-08-31')).toBe('2025-02-28');
    expect(probationEndDate('Probationary', '2024-01-15')).toBe('2024-07-15');
    expect(probationEndDate('Regular', '2024-01-15')).toBeNull();
    expect(addMonths('2023-08-31', 6)).toBe('2024-02-29');
  });
});
