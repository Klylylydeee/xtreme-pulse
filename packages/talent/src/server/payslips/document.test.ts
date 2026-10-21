import { describe, expect, it } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import { inflateSync } from 'node:zlib';
import { type Centavos, formatPeso } from '@pulse/core';
import {
  PAYSLIP_ADJUSTED_LABEL,
  PAYSLIP_ADJUSTMENTS_LABEL,
  PAYSLIP_PAID_OTHERWISE_TEXT,
  type PayslipView,
} from '../../payroll-run';
import {
  PAYSLIP_COMPANY_MISSING_TEXT,
  type PayslipCompany,
  PayslipPdf,
  renderPayslipPdf,
} from './document';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 (case A1, the
// payslip's contents; HANDOFF item 289). The repo has no PDF text extractor, so the printed text is
// read from the document's element tree (every string react-pdf lays out), and the rendered bytes
// are checked to be a valid one-page PDF.

// Test amounts only, never money arithmetic.
const pesos = (amount: number): Centavos => Math.round(amount * 100);

/** P1’s payslip in case A1 (the figures step 2.9's engine computes; invented people, item 318). */
const A1_VIEW: PayslipView = {
  title: 'Payslip PAY-2026-0001',
  runNumber: 'PAY-2026-0001',
  employee: {
    name: 'Juan Dela Cruz',
    number: 'XW-0001',
    department: 'Engineering',
    position: 'Network Engineer',
  },
  periodStart: '2026-09-26',
  periodEnd: '2026-10-10',
  periodText: 'Sep 26 – Oct 10, 2026',
  payDate: '2026-10-15',
  payDateText: 'Oct 15, 2026',
  earnings: [
    ['Basic pay', pesos(10875)],
    ['Overtime', pesos(1250)],
    ['Rest day work', pesos(650)],
    ['Night differential', pesos(12.5)],
    ['Internet allowance', pesos(500)],
    ['Reimbursements (1 receipt)', pesos(350)],
  ].map(([label, amount]) => ({
    label: label as string,
    amountCentavos: amount as number,
    manual: false,
    adjusted: false,
  })),
  deductions: [
    ['Absences', pesos(1000)],
    ['Late', pesos(62.5)],
    ['SSS', pesos(550)],
    ['PhilHealth', pesos(271.88)],
    ['Pag-IBIG', pesos(100)],
    ['Withholding tax', pesos(57.92)],
  ].map(([label, amount]) => ({
    label: label as string,
    amountCentavos: amount as number,
    manual: false,
    adjusted: false,
  })),
  adjustments: [],
  adjustmentsLabel: PAYSLIP_ADJUSTMENTS_LABEL,
  adjustedLabel: PAYSLIP_ADJUSTED_LABEL,
  grossCentavos: pesos(13637.5),
  deductionsCentavos: pesos(2042.3),
  netPayCentavos: pesos(11595.2),
  creditedText: 'Credited to UnionBank ending 4321',
  yearToDate: {
    grossCentavos: pesos(13637.5),
    taxWithheldCentavos: pesos(57.92),
    sssEmployeeCentavos: pesos(550),
    philhealthEmployeeCentavos: pesos(271.88),
    pagibigEmployeeCentavos: pesos(100),
    contributionsCentavos: pesos(921.88),
  },
};

/** The full account number the view never holds (its last 4 are 4321). */
const FULL_ACCOUNT_NUMBER = '109876544321';

// A 1×1 PNG.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const COMPANY: PayslipCompany = {
  registeredName: 'Xtreme Works Test Co.',
  businessAddress: '[Business address]',
  logo: { bytes: new Uint8Array(PNG_1X1), contentType: 'image/png' },
};

/** Every string the document lays out, in order (function components are called). */
function textOf(node: ReactNode): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return [];
  if (typeof node === 'string' || typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(textOf);
  if (!isValidElement(node)) return [];
  const { type, props } = node as { type: unknown; props: { children?: ReactNode } };
  if (typeof type === 'function') return textOf((type as (p: unknown) => ReactNode)(props));
  return textOf(props.children);
}

const printed = (view: PayslipView, company: PayslipCompany | null) =>
  textOf(PayslipPdf({ view, company })).join('\n');

function pdfInfo(bytes: Uint8Array) {
  const raw = Buffer.from(bytes).toString('latin1');
  // Inflate every compressed stream so nothing hides in them.
  const streams: string[] = [];
  const pattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    try {
      streams.push(inflateSync(Buffer.from(match[1] ?? '', 'latin1')).toString('latin1'));
    } catch {
      // Not deflated (an image or a font table): kept raw below.
    }
  }
  return {
    header: raw.slice(0, 5),
    endsWithEof: raw.trimEnd().endsWith('%%EOF'),
    pages: raw.match(/\/Type\s*\/Page(?!s)/g)?.length ?? 0,
    images: raw.match(/\/Subtype\s*\/Image/g)?.length ?? 0,
    all: raw + streams.join('\n'),
  };
}

describe('the payslip PDF (decision 366)', () => {
  it('A1: renders a valid one-page PDF', async () => {
    const pdf = pdfInfo(await renderPayslipPdf(A1_VIEW, COMPANY));
    expect(pdf.header).toBe('%PDF-');
    expect(pdf.endsWithEof).toBe(true);
    expect(pdf.pages).toBe(1);
    expect(pdf.images).toBeGreaterThan(0); // The logo (and its alpha mask).
    expect(pdf.all).not.toContain(FULL_ACCOUNT_NUMBER);
  });

  it('A1: prints the spec’s fields and figures, and no employer share, rate or account number', () => {
    const text = printed(A1_VIEW, COMPANY);
    for (const expected of [
      'Xtreme Works Test Co.',
      '[Business address]',
      'Payslip PAY-2026-0001',
      'Juan Dela Cruz',
      'XW-0001',
      'Engineering',
      'Network Engineer',
      'Sep 26 – Oct 10, 2026',
      'Oct 15, 2026',
      'Earnings',
      'Basic pay',
      '₱10,875.00',
      'Deductions',
      'Withholding tax',
      'Gross pay\n₱13,637.50',
      'Total deductions\n₱2,042.30',
      'Net pay\n₱11,595.20',
      'Credited to UnionBank ending 4321',
      'Year to date',
      'Tax withheld\n₱57.92',
      'Contributions\n₱921.88',
    ]) {
      expect(text).toContain(expected);
    }
    // Year-to-date gross equals this cut-off's (no opening entry): printed twice.
    expect(text.split('₱13,637.50').length - 1).toBe(2);
    expect(text).not.toContain(FULL_ACCOUNT_NUMBER);
    expect(text).not.toMatch(/employer|rate|EC\b|a month/i);
    // No section for adjustments when there are none.
    expect(text).not.toContain(PAYSLIP_ADJUSTMENTS_LABEL);
  });

  it('prints adjustments, manual entries and "Adjusted"', () => {
    const view: PayslipView = {
      ...A1_VIEW,
      earnings: [
        ...A1_VIEW.earnings,
        {
          label: 'Adjustment: Back pay',
          amountCentavos: pesos(1000),
          manual: true,
          adjusted: false,
        },
      ],
      deductions: A1_VIEW.deductions.map((line) =>
        line.label === 'Withholding tax' ? { ...line, amountCentavos: 0, adjusted: true } : line,
      ),
      adjustments: [
        {
          label: 'Absences · Sep 10 – Sep 25',
          amountCentavos: -pesos(1000),
          manual: false,
          adjusted: false,
        },
      ],
    };
    const text = printed(view, COMPANY);
    expect(text).toContain('Adjustment: Back pay\n₱1,000.00');
    expect(text).toContain(`Withholding tax\n · ${PAYSLIP_ADJUSTED_LABEL}\n₱0.00`);
    expect(text).toContain(`${PAYSLIP_ADJUSTMENTS_LABEL}\nAbsences · Sep 10 – Sep 25`);
    expect(text).toContain(formatPeso(-pesos(1000)));
  });

  it('renders with no bank account', async () => {
    const view = { ...A1_VIEW, creditedText: PAYSLIP_PAID_OTHERWISE_TEXT };
    const text = printed(view, COMPANY);
    expect(text).toContain('Paid by other means');
    expect(text).not.toContain('Credited to');
    expect(pdfInfo(await renderPayslipPdf(view, COMPANY)).pages).toBe(1);
  });

  it('renders with no company details, and with a logo it can’t draw', async () => {
    const missing = pdfInfo(await renderPayslipPdf(A1_VIEW, null));
    expect(missing.header).toBe('%PDF-');
    expect(missing.pages).toBe(1);
    expect(missing.images).toBe(0);
    expect(printed(A1_VIEW, null)).toContain(PAYSLIP_COMPANY_MISSING_TEXT);

    const webp = { ...COMPANY, logo: { bytes: new Uint8Array(8), contentType: 'image/webp' } };
    const noLogo = pdfInfo(await renderPayslipPdf(A1_VIEW, webp));
    expect(noLogo.pages).toBe(1);
    expect(noLogo.images).toBe(0);
    expect(printed(A1_VIEW, { ...COMPANY, logo: null })).toContain('Xtreme Works Test Co.');
  });
});
