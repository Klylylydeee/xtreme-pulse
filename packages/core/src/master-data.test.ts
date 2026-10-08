import { describe, expect, it } from 'vitest';
import {
  catalogItemInputSchema,
  catalogItemUpdateSchema,
  clientContactInputSchema,
  clientInputSchema,
  formatTin,
  isPhMobile,
  isValidTin,
  normalizeTin,
  supplierInputSchema,
  VAT_TREATMENT_LABELS,
} from './master-data';

// The master data field helpers (docs/TESTING.md#master-data-tests). Made-up data only.

const ID = '64b7f0c2a1b2c3d4e5f60718';

describe('TIN', () => {
  it('strips dashes and spaces only', () => {
    expect(normalizeTin(' 123-456 789 ')).toBe('123456789');
    expect(normalizeTin('123.456.789')).toBe('123.456.789');
  });

  it('accepts only 9, 12 or 14 digits', () => {
    for (const digits of ['123456789', '123456789000', '12345678900000']) {
      expect(isValidTin(digits)).toBe(true);
    }
    for (const digits of [
      '',
      '12345678',
      '1234567890',
      '12345678901',
      '1234567890123',
      'abcdefghi',
    ]) {
      expect(isValidTin(digits)).toBe(false);
    }
  });

  it('shows groups of three, the last group taking the rest', () => {
    expect(formatTin('123456789')).toBe('123-456-789');
    expect(formatTin('123456789000')).toBe('123-456-789-000');
    expect(formatTin('12345678900000')).toBe('123-456-789-00000');
    expect(formatTin('1234')).toBe('1234');
  });

  it('is optional on a client, stored as digits', () => {
    expect(clientInputSchema.parse({ name: 'Banco Uno' }).tin).toBeNull();
    expect(clientInputSchema.parse({ name: 'Banco Uno', tin: '' }).tin).toBeNull();
    expect(clientInputSchema.parse({ name: 'Banco Uno', tin: '123-456-789-000' }).tin).toBe(
      '123456789000',
    );
    expect(clientInputSchema.safeParse({ name: 'Banco Uno', tin: '123-456' }).success).toBe(false);
  });
});

describe('mobile', () => {
  it('accepts the +63, 63 and 0 forms with spaces, dashes and parentheses', () => {
    for (const value of [
      '09171234567',
      '0917 123 4567',
      '0917-123-4567',
      '(0917) 123-4567',
      '+63 917 123 4567',
      '+639171234567',
      '63 917 123 4567',
    ]) {
      expect(isPhMobile(value), value).toBe(true);
    }
  });

  it('refuses anything else', () => {
    for (const value of [
      '',
      '0817 123 4567',
      '0917 123 456',
      '0917 123 45678',
      '+1 917 123 4567',
    ]) {
      expect(isPhMobile(value), value).toBe(false);
    }
  });

  it('is stored as typed and the email is lowercased', () => {
    const parsed = clientContactInputSchema.parse({
      clientId: ID,
      name: 'Ana Cruz',
      mobile: '+63 917 123 4567',
      email: ' Ana.Cruz@Example.COM ',
    });
    expect(parsed.mobile).toBe('+63 917 123 4567');
    expect(parsed.email).toBe('ana.cruz@example.com');
    expect(parsed.isPrimary).toBe(false);
    expect(
      clientContactInputSchema.safeParse({ clientId: ID, name: 'Ana', email: 'not-an-email' })
        .success,
    ).toBe(false);
  });
});

describe('client fields', () => {
  it('defaults to VAT-registered and VAT-exclusive, with no rate in the label', () => {
    const parsed = clientInputSchema.parse({ name: 'Banco Uno', vatTreatment: '' });
    expect(parsed.vatTreatment).toBe('vatRegistered');
    expect(parsed.priceDisplay).toBe('vatExclusive');
    expect(VAT_TREATMENT_LABELS.vatRegistered).toBe('VAT-registered');
    expect(parsed.allowDuplicateName).toBe(false);
    expect(
      clientInputSchema.parse({ name: 'X', allowDuplicateName: 'true' }).allowDuplicateName,
    ).toBe(true);
  });

  it('takes credit terms as whole days from 0 to 365, empty meaning none', () => {
    expect(clientInputSchema.parse({ name: 'X', creditTermsDays: '' }).creditTermsDays).toBeNull();
    expect(clientInputSchema.parse({ name: 'X', creditTermsDays: '30' }).creditTermsDays).toBe(30);
    expect(clientInputSchema.parse({ name: 'X', creditTermsDays: 0 }).creditTermsDays).toBe(0);
    expect(clientInputSchema.parse({ name: 'X', creditTermsDays: 365 }).creditTermsDays).toBe(365);
    for (const value of [-1, 366, 1.5, 'abc']) {
      expect(clientInputSchema.safeParse({ name: 'X', creditTermsDays: value }).success).toBe(
        false,
      );
    }
  });

  it('caps industry at 100 characters', () => {
    expect(clientInputSchema.safeParse({ name: 'X', industry: 'a'.repeat(100) }).success).toBe(
      true,
    );
    expect(clientInputSchema.safeParse({ name: 'X', industry: 'a'.repeat(101) }).success).toBe(
      false,
    );
  });
});

describe('catalog item fields', () => {
  const item = { brandId: ID, partNumber: 'P-1', description: 'Switch', unit: 'pc' };

  it('defaults the warranty to 12 months and keeps it within 0 to 120', () => {
    expect(
      catalogItemInputSchema.parse({ ...item, itemKind: 'serialized' }).defaultWarrantyMonths,
    ).toBe(12);
    expect(
      catalogItemInputSchema.parse({ ...item, itemKind: 'nonStock', defaultWarrantyMonths: '0' })
        .defaultWarrantyMonths,
    ).toBe(0);
    for (const value of [-1, 121, 2.5]) {
      expect(
        catalogItemInputSchema.safeParse({
          ...item,
          itemKind: 'bulk',
          defaultWarrantyMonths: value,
        }).success,
      ).toBe(false);
    }
  });

  it('refuses an unknown item kind, and an edit carries no product or kind', () => {
    expect(catalogItemInputSchema.safeParse({ ...item, itemKind: 'other' }).success).toBe(false);
    const parsed = catalogItemUpdateSchema.parse({ ...item, itemKind: 'bulk' });
    expect(parsed).not.toHaveProperty('brandId');
    expect(parsed).not.toHaveProperty('itemKind');
  });
});

describe('supplier fields', () => {
  it('defaults to a distributor with no contacts or products', () => {
    const parsed = supplierInputSchema.parse({ name: 'Acme Distribution' });
    expect(parsed.supplierType).toBe('distributor');
    expect(parsed.contacts).toEqual([]);
    expect(parsed.brandIds).toEqual([]);
    expect(parsed.paymentTermsDays).toBeNull();
  });

  it('allows at most 20 contacts, each checked like a client contact', () => {
    const contacts = Array.from({ length: 20 }, (_, i) => ({ name: `Contact ${i}` }));
    expect(supplierInputSchema.safeParse({ name: 'S', contacts }).success).toBe(true);
    expect(
      supplierInputSchema.safeParse({ name: 'S', contacts: [...contacts, { name: 'One more' }] })
        .success,
    ).toBe(false);
    expect(
      supplierInputSchema.safeParse({ name: 'S', contacts: [{ name: 'A', mobile: '12345' }] })
        .success,
    ).toBe(false);
  });

  it('lists each product once and takes payment terms from 0 to 365', () => {
    expect(supplierInputSchema.parse({ name: 'S', brandIds: [ID, ID] }).brandIds).toEqual([ID]);
    expect(supplierInputSchema.parse({ name: 'S', brandIds: ID }).brandIds).toEqual([ID]);
    expect(supplierInputSchema.safeParse({ name: 'S', paymentTermsDays: 366 }).success).toBe(false);
  });
});
