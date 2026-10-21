// Automatic JSX runtime even when a runner (tsx in the worker) reads another package's tsconfig.
/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { type Centavos, formatPeso } from '@pulse/core';
import { PDF_FONT_FAMILY, pdfColors, renderPdf } from '@pulse/core/server/exports';
import { PAYSLIP_YTD_LABEL, type PayslipLine, type PayslipView } from '../../payroll-run';

// Spec: docs/modules/talent.md#payroll-review-approval-and-payslips-build-step-210 ("Payslips",
// decision 366 in docs/BUILD_PLAN.md; HANDOFF items 289, 311 and 331) and
// docs/DESIGN_SYSTEM.md (the payslip PDF) — the payslip as a react-pdf document, rendered with
// Core's `renderPdf` in Inter on light paper with the light-appearance tokens. It prints only what
// the view model holds: no employer share, rate, computation fact or full account number. The
// company header is read by the caller when the PDF is rendered; a placeholder prints as it is.
// Pure: no database, no file read except Core's fonts and tokens. The caller saves the bytes with
// `saveGeneratedFile` (Core's PDF_CONTENT_TYPE).

/** The logo types react-pdf can draw. A WebP logo must be converted to PNG by the caller. */
export const PAYSLIP_LOGO_TYPES = ['image/png', 'image/jpeg'] as const;

/** The company header, read from Core's company settings when the PDF is rendered. */
export interface PayslipCompany {
  registeredName: string;
  businessAddress: string;
  /** The logo's bytes and type; null while none is uploaded. Other types than PNG and JPEG are left out. */
  logo: { bytes: Uint8Array; contentType: string } | null;
}

/** Printed in place of the header when there is no company settings record (before the seed). */
export const PAYSLIP_COMPANY_MISSING_TEXT = 'Company details are not set.';

/** Printed under a section with no lines. */
export const PAYSLIP_NO_LINES_TEXT = 'None';

function payslipStyles() {
  const color = pdfColors();
  return StyleSheet.create({
    page: {
      paddingTop: 36,
      paddingBottom: 44,
      paddingHorizontal: 40,
      fontFamily: PDF_FONT_FAMILY,
      fontSize: 10.5,
      lineHeight: 1.3,
      color: color.text,
    },
    header: { flexDirection: 'row', alignItems: 'center', marginBottom: 16 },
    logo: { maxHeight: 44, maxWidth: 120, marginRight: 12, objectFit: 'contain' },
    companyName: { fontSize: 13, fontWeight: 700 },
    secondary: { color: color.secondary },
    small: { fontSize: 9, color: color.secondary },
    title: { fontSize: 18, fontWeight: 700, marginBottom: 10 },
    block: {
      backgroundColor: color.fill,
      borderRadius: 6,
      paddingVertical: 8,
      paddingHorizontal: 10,
      marginBottom: 12,
    },
    section: { marginBottom: 12 },
    summary: { flexDirection: 'row', alignItems: 'flex-start' },
    summaryColumn: { flex: 1 },
    summaryGap: { width: 16 },
    sectionTitle: {
      fontSize: 12,
      fontWeight: 700,
      paddingBottom: 4,
      borderBottomWidth: 1,
      borderBottomColor: color.separator,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingVertical: 3,
      borderBottomWidth: 0.5,
      borderBottomColor: color.separator,
    },
    fact: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
    label: { flex: 1, paddingRight: 12 },
    amount: { textAlign: 'right' },
    bold: { fontWeight: 700 },
    net: { fontSize: 14, fontWeight: 700 },
    credited: { marginTop: 6, color: color.secondary },
  });
}

type Styles = ReturnType<typeof payslipStyles>;

function logoSource(logo: PayslipCompany['logo']) {
  if (!logo) return null;
  if (logo.contentType === 'image/png')
    return { data: Buffer.from(logo.bytes), format: 'png' as const };
  if (logo.contentType === 'image/jpeg')
    return { data: Buffer.from(logo.bytes), format: 'jpg' as const };
  return null;
}

function CompanyHeader({ company, styles }: { company: PayslipCompany | null; styles: Styles }) {
  if (!company) {
    return (
      <View style={styles.header}>
        <Text style={styles.secondary}>{PAYSLIP_COMPANY_MISSING_TEXT}</Text>
      </View>
    );
  }
  const logo = logoSource(company.logo);
  return (
    <View style={styles.header}>
      {logo ? <Image style={styles.logo} src={logo} /> : null}
      <View style={{ flex: 1 }}>
        <Text style={styles.companyName}>{company.registeredName}</Text>
        <Text style={styles.small}>{company.businessAddress}</Text>
      </View>
    </View>
  );
}

function Fact({ label, value, styles }: { label: string; value: string; styles: Styles }) {
  return (
    <View style={styles.fact}>
      <Text style={[styles.label, styles.secondary]}>{label}</Text>
      <Text style={styles.amount}>{value}</Text>
    </View>
  );
}

function Lines({
  title,
  lines,
  adjustedLabel,
  styles,
}: {
  title: string;
  lines: readonly PayslipLine[];
  adjustedLabel: string;
  styles: Styles;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {lines.length === 0 ? (
        <View style={styles.row}>
          <Text style={styles.secondary}>{PAYSLIP_NO_LINES_TEXT}</Text>
        </View>
      ) : (
        lines.map((line, index) => (
          <View key={index} style={styles.row} wrap={false}>
            <Text style={styles.label}>
              {line.label}
              {line.adjusted ? <Text style={styles.secondary}>{` · ${adjustedLabel}`}</Text> : null}
            </Text>
            <Text style={styles.amount}>{formatPeso(line.amountCentavos)}</Text>
          </View>
        ))
      )}
    </View>
  );
}

function Total({
  label,
  amount,
  styles,
  net = false,
}: {
  label: string;
  amount: Centavos;
  styles: Styles;
  net?: boolean;
}) {
  const style = net ? styles.net : styles.bold;
  return (
    <View style={styles.fact}>
      <Text style={[styles.label, style]}>{label}</Text>
      <Text style={[styles.amount, style]}>{formatPeso(amount)}</Text>
    </View>
  );
}

/** The payslip document: company header, employee block, lines, totals and year-to-date. */
export function PayslipPdf({
  view,
  company,
}: {
  view: PayslipView;
  company: PayslipCompany | null;
}) {
  const styles = payslipStyles();
  const ytd = view.yearToDate;
  return (
    <Document title={view.title}>
      <Page size="A4" style={styles.page}>
        <CompanyHeader company={company} styles={styles} />
        <Text style={styles.title}>{view.title}</Text>

        <View style={styles.block} wrap={false}>
          <Fact label="Employee" value={view.employee.name} styles={styles} />
          <Fact label="Employee number" value={view.employee.number} styles={styles} />
          {view.employee.department ? (
            <Fact label="Department" value={view.employee.department} styles={styles} />
          ) : null}
          {view.employee.position ? (
            <Fact label="Position" value={view.employee.position} styles={styles} />
          ) : null}
          <Fact label="Cut-off period" value={view.periodText} styles={styles} />
          <Fact label="Pay date" value={view.payDateText} styles={styles} />
        </View>

        <Lines
          title="Earnings"
          lines={view.earnings}
          adjustedLabel={view.adjustedLabel}
          styles={styles}
        />
        <Lines
          title="Deductions"
          lines={view.deductions}
          adjustedLabel={view.adjustedLabel}
          styles={styles}
        />
        {view.adjustments.length > 0 ? (
          <Lines
            title={view.adjustmentsLabel}
            lines={view.adjustments}
            adjustedLabel={view.adjustedLabel}
            styles={styles}
          />
        ) : null}

        <View style={styles.summary} wrap={false}>
          <View style={[styles.block, styles.summaryColumn]}>
            <Total label="Gross pay" amount={view.grossCentavos} styles={styles} />
            <Total label="Total deductions" amount={view.deductionsCentavos} styles={styles} />
            <Total label="Net pay" amount={view.netPayCentavos} styles={styles} net />
            <Text style={styles.credited}>{view.creditedText}</Text>
          </View>
          <View style={styles.summaryGap} />
          <View style={[styles.section, styles.summaryColumn]}>
            <Text style={styles.sectionTitle}>{PAYSLIP_YTD_LABEL}</Text>
            <Fact label="Gross pay" value={formatPeso(ytd.grossCentavos)} styles={styles} />
            <Fact
              label="Tax withheld"
              value={formatPeso(ytd.taxWithheldCentavos)}
              styles={styles}
            />
            <Fact label="SSS" value={formatPeso(ytd.sssEmployeeCentavos)} styles={styles} />
            <Fact
              label="PhilHealth"
              value={formatPeso(ytd.philhealthEmployeeCentavos)}
              styles={styles}
            />
            <Fact
              label="Pag-IBIG"
              value={formatPeso(ytd.pagibigEmployeeCentavos)}
              styles={styles}
            />
            <Total label="Contributions" amount={ytd.contributionsCentavos} styles={styles} />
          </View>
        </View>
      </Page>
    </Document>
  );
}

/**
 * Renders a finalized line's payslip to PDF bytes (decision 366). `view` comes from
 * `buildPayslipView` (the frozen snapshot and year-to-date); `company` is Core's company details as
 * they are now, or null when there is no settings record. Never log the bytes.
 */
export function renderPayslipPdf(
  view: PayslipView,
  company: PayslipCompany | null,
): Promise<Uint8Array> {
  return renderPdf(<PayslipPdf view={view} company={company} />);
}
