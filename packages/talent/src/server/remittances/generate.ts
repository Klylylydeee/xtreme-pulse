import { Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { ActionError, businessToday, isPlaceholder } from '@pulse/core';
import {
  CompanySettingsMissingError,
  decryptSensitive,
  getCompanySettings,
  listEmployeeIdentities,
  recordAudit,
  reloadActorAccess,
} from '@pulse/core/server';
import { parsePayrollBreakdown } from '../../payroll-run';
import {
  buildRemittanceReport,
  currentRemittanceFormatId,
  goLivePeriodsText,
  isRemittanceAgency,
  isRemittanceMonth,
  REMITTANCE_GO_LIVE_REQUIRED_MESSAGE,
  REMITTANCE_PAID_LOCKED_MESSAGE,
  REMITTANCE_REPORT_CHANGED_MESSAGE,
  type RemittanceAgency,
  remittanceAuditLabel,
  remittanceDueDate,
  type RemittanceEmployee,
  type RemittanceEmployerDetails,
  type RemittanceMonth,
  type RemittanceSourceLine,
  type RemittanceSourceRun,
} from '../../remittance';
import { EMPLOYEE_RECORD_SENSITIVE_SELECT, EmployeeRecordModel } from '../employee-records/model';
import { REMITTANCE_SETTINGS_SETTING } from '../payroll-settings/settings';
import {
  PAGIBIG_CONTRIBUTIONS_SETTING,
  PHILHEALTH_CONTRIBUTIONS_SETTING,
  SSS_CONTRIBUTIONS_SETTING,
} from '../payroll-settings/settings';
import { PAYROLL_READER } from '../payroll-runs/compute';
import { PayrollRunEmployeeModel } from '../payroll-runs/model';
import { assertCanGenerateRemittances, type TalentActor } from '../policy';
import { dayOf, dayOrNull, instantOf, isDuplicateKey, objectIdOf } from '../shared';
import {
  REMITTANCE_REPORT_RECORD_TYPE,
  type RemittanceReportDocument,
  RemittanceReportModel,
  type RemittanceSettingVersionRef,
} from './model';
import { REMITTANCE_NOT_FOUND } from './service';
import { encryptRows, encryptTotals } from './snapshot';
import {
  loadMonthSources,
  loadRemittanceContext,
  type RemittanceContext,
  type RemittanceRunRow,
  remittanceSettingsFor,
} from './sources';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Reports":
// generating, regenerating, placeholder company details; "Who may see and do what"; decisions
// 378–381, 385, 386 and 394 in docs/BUILD_PLAN.md) and SECURITY.md#audit-logging.
//
// - "Generate report" / "Regenerate": Talent Write and HR or the System Administrator, checked
//   here and again in the transaction against the account as it is then. Refused while the month
//   isn't complete (naming the cut-off still to finalize) and, for a regenerate, while the report
//   is paid ("Void the payment first …") or changed since the page loaded.
// - Reads the source runs' lines (decrypting their breakdowns), today's identities and government
//   IDs and the company details outside the transaction (HANDOFF › 2.11 notes, "Risks"), builds
//   the snapshot with the pure engine, encrypts the rows and totals, then in one transaction
//   inserts the report (audited `create`) or replaces its snapshot, resets its files and raises
//   `version` (audited `update`, reason "Regenerated"). No entry holds an amount or an ID.
// - A placeholder employer number (or TIN for BIR) doesn't stop it: the report notes it.
//
// Never log anything from here: the decrypted breakdowns and IDs are sensitive.

export const REMITTANCE_REGENERATED_REASON = 'Regenerated';

/** The company detail each agency prints as its employer number. */
const EMPLOYER_NUMBER_OF: Record<
  RemittanceAgency,
  'sssEmployerNumber' | 'philhealthEmployerNumber' | 'pagibigEmployerId' | 'tin'
> = {
  sss: 'sssEmployerNumber',
  philhealth: 'philhealthEmployerNumber',
  pagibig: 'pagibigEmployerId',
  bir1601c: 'tin',
};

const blank = (value: string) => value.trim() === '' || isPlaceholder(value);

/** The employer's details now, for `agency` (company data, plain). */
async function employerDetails(agency: RemittanceAgency): Promise<RemittanceEmployerDetails> {
  try {
    const settings = await getCompanySettings();
    const employerNumber = settings[EMPLOYER_NUMBER_OF[agency]];
    return {
      registeredName: settings.registeredName,
      businessAddress: settings.businessAddress,
      tin: settings.tin,
      rdoCode: settings.rdoCode,
      employerNumber,
      placeholder: blank(employerNumber),
    };
  } catch (error) {
    if (!(error instanceof CompanySettingsMissingError)) throw error;
    return {
      registeredName: '',
      businessAddress: '',
      tin: '',
      rdoCode: '',
      employerNumber: '',
      placeholder: true,
    };
  }
}

/** The contribution tables a run stored, from the loaded versions (null when not found). */
function tablesOf(
  run: RemittanceRunRow,
  context: RemittanceContext,
): RemittanceSourceRun['tables'] {
  const effectiveOf = (key: string) =>
    run.settingVersions.find((version) => version.key === key)?.effectiveFrom ?? null;
  const find = <T>(list: readonly { effectiveFrom: string; value: T }[], key: string): T | null => {
    const effectiveFrom = effectiveOf(key);
    return effectiveFrom
      ? (list.find((version) => version.effectiveFrom === effectiveFrom)?.value ?? null)
      : null;
  };
  return {
    sss: find(context.versions.sss, SSS_CONTRIBUTIONS_SETTING.key),
    philhealth: find(context.versions.philhealth, PHILHEALTH_CONTRIBUTIONS_SETTING.key),
    pagibig: find(context.versions.pagibig, PAGIBIG_CONTRIBUTIONS_SETTING.key),
  };
}

async function decryptedText(value: unknown): Promise<string | null> {
  if (value === undefined || value === null) return null;
  const text = await decryptSensitive(value);
  return typeof text === 'string' && text.trim() !== '' ? text : null;
}

/** Today's identities, IDs, date of birth, sex and verification of the line's employees. */
async function loadEmployees(
  employeeIds: readonly string[],
): Promise<Map<string, RemittanceEmployee>> {
  const wanted = new Set(employeeIds);
  const identities = (await listEmployeeIdentities(PAYROLL_READER, { separated: true })).filter(
    (identity) => wanted.has(identity.employeeId),
  );
  const records = await EmployeeRecordModel.find({
    employeeId: { $in: [...wanted].map((id) => new Types.ObjectId(id)) },
  })
    .select(EMPLOYEE_RECORD_SENSITIVE_SELECT)
    .lean();
  const recordOf = new Map(records.map((record) => [record.employeeId.toHexString(), record]));
  const result = new Map<string, RemittanceEmployee>();
  for (const identity of identities) {
    const record = recordOf.get(identity.employeeId);
    const ids = record?.governmentIds;
    result.set(identity.employeeId, {
      employeeId: identity.employeeId,
      employeeNumber: identity.employeeNumber,
      firstName: identity.firstName,
      middleName: identity.middleName,
      lastName: identity.lastName,
      dateHired: identity.dateHired,
      separationDate: identity.separationDate,
      dateOfBirth: dayOrNull(record?.dateOfBirth ?? null),
      sex: record?.sex ?? null,
      ids: {
        sss: await decryptedText(ids?.sss),
        philhealth: await decryptedText(ids?.philhealth),
        pagibig: await decryptedText(ids?.pagibig),
        tin: await decryptedText(ids?.tin),
      },
      idsVerified: Boolean(record?.governmentIdsVerification),
    });
  }
  for (const id of wanted) {
    if (!result.has(id)) throw new Error('A payroll line’s employee is missing from Pulse Core.');
  }
  return result;
}

export interface GenerateRemittanceInput {
  agency: unknown;
  month: unknown;
  /** The report's version the page shows, for a regenerate; omitted for the first generate. */
  version?: unknown;
}

export interface GeneratedRemittance {
  reportId: string;
  version: number;
  /** True when this replaced an existing report's snapshot. */
  regenerated: boolean;
}

/**
 * "Generate report" or "Regenerate" (see the header). Answers the report's id and version.
 */
export async function generateRemittanceReport(
  actor: TalentActor,
  input: GenerateRemittanceInput,
): Promise<GeneratedRemittance> {
  assertCanGenerateRemittances(actor);
  const { agency, month } = input;
  if (!isRemittanceAgency(agency) || !isRemittanceMonth(month)) {
    throw new ActionError(REMITTANCE_NOT_FOUND);
  }
  const expectedVersion =
    input.version === undefined || input.version === null ? null : Number(input.version);
  if (expectedVersion !== null && !Number.isSafeInteger(expectedVersion)) {
    throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
  }
  const today = businessToday();
  const context = await loadRemittanceContext(today);
  if (!context.firstCutOff || !context.firstMonth) {
    throw new ActionError(REMITTANCE_GO_LIVE_REQUIRED_MESSAGE);
  }
  if (month < context.firstMonth) throw new ActionError(REMITTANCE_NOT_FOUND);
  const sources = (await loadMonthSources(context, [month])).get(month);
  if (!sources) throw new ActionError(REMITTANCE_NOT_FOUND);
  if (sources.incompleteMessage) throw new ActionError(sources.incompleteMessage);

  // A paid report is locked: refuse before reading anything sensitive.
  await connectDb();
  const existing = await RemittanceReportModel.findOne(
    { agency, month },
    { status: 1, version: 1 },
  ).lean<Pick<RemittanceReportDocument, '_id' | 'status' | 'version'>>();
  if (existing?.status === 'paid') throw new ActionError(REMITTANCE_PAID_LOCKED_MESSAGE);
  // A regenerate names the version the page shows; a first generate (no version) on a report
  // another user generated since the page loaded is refused, never a silent regenerate.
  if (existing && (expectedVersion === null || existing.version !== expectedVersion)) {
    throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
  }
  if (!existing && expectedVersion !== null) {
    throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
  }

  // Read the source lines and identities outside the transaction.
  const runs: RemittanceSourceRun[] = sources.sourceRuns.map((run) => ({
    runId: run._id.toHexString(),
    number: run.number,
    periodStart: dayOf(run.periodStart),
    periodEnd: dayOf(run.periodEnd),
    payDate: dayOf(run.payDate),
    tables: tablesOf(run, context),
  }));
  const stored = await PayrollRunEmployeeModel.find(
    { runId: { $in: sources.sourceRuns.map((run) => run._id) } },
    { runId: 1, employeeId: 1 },
  )
    .select('+breakdown')
    .lean<{ runId: Types.ObjectId; employeeId: Types.ObjectId; breakdown?: unknown }[]>();
  const lines: RemittanceSourceLine[] = [];
  for (const line of stored) {
    if (!line.breakdown) throw new Error('A payroll run line has no breakdown.');
    lines.push({
      runId: line.runId.toHexString(),
      employeeId: line.employeeId.toHexString(),
      breakdown: parsePayrollBreakdown(String(await decryptSensitive(line.breakdown))),
    });
  }
  const employees = await loadEmployees([...new Set(lines.map((line) => line.employeeId))]);
  const built = buildRemittanceReport({ agency, month, runs, lines, employees });
  const settings = remittanceSettingsFor(context, month);
  const dueDate = remittanceDueDate(agency, month, settings.value);
  const employer = await employerDetails(agency);
  const settingVersions: RemittanceSettingVersionRef[] = [
    { key: REMITTANCE_SETTINGS_SETTING.key, effectiveFrom: settings.effectiveFrom },
    ...uniqueTableVersions(sources.sourceRuns),
  ];
  const snapshot = {
    generatedAt: new Date(),
    generatedBy: new Types.ObjectId(actor.id),
    sourceRuns: sources.sourceRuns.map((run) => ({
      runId: run._id,
      number: run.number,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
    })),
    goLiveNote: goLivePeriodsText(sources.paidBeforeGoLive),
    employeeCount: built.rows.length,
    flagCounts: built.flagCounts,
    employer,
    settingVersions,
    dueDate: instantOf(dueDate),
    formatId: currentRemittanceFormatId(agency),
    rows: await encryptRows(built.rows),
    totals: await encryptTotals(built.totals),
  };
  const auditAfter = (version: number) => ({
    agency,
    month,
    version,
    employeeCount: snapshot.employeeCount,
    flagCounts: snapshot.flagCounts,
    sourceRuns: snapshot.sourceRuns.map((run) => run.number),
    dueDate,
    formatId: snapshot.formatId,
  });
  const label = remittanceAuditLabel(agency, month);

  try {
    return await withTransaction(async (session) => {
      const current = await reloadActorAccess({ id: actor.id }, session);
      assertCanGenerateRemittances(current);
      const report = await RemittanceReportModel.findOne(
        { agency, month },
        { status: 1, version: 1 },
      )
        .session(session)
        .lean<Pick<RemittanceReportDocument, '_id' | 'status' | 'version'>>();
      if (!report) {
        if (existing) throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
        const [created] = await RemittanceReportModel.create(
          [{ agency, month, status: 'generated', version: 1, ...snapshot, createdBy: current.id }],
          { session },
        );
        if (!created) throw new Error('The remittance report was not saved.');
        await recordAudit(
          {
            actorId: current.id,
            actorEmail: current.email,
            module: 'talent',
            action: 'create',
            record: { type: REMITTANCE_REPORT_RECORD_TYPE, id: created._id, label },
            before: null,
            after: auditAfter(1),
          },
          { session },
        );
        return { reportId: created._id.toHexString(), version: 1, regenerated: false };
      }
      if (report.status === 'paid') throw new ActionError(REMITTANCE_PAID_LOCKED_MESSAGE);
      if (!existing || expectedVersion === null || report.version !== existing.version) {
        throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
      }
      const updated = await RemittanceReportModel.updateOne(
        { _id: report._id, status: 'generated', version: report.version },
        {
          $set: {
            ...snapshot,
            files: { pdf: null, xlsx: null, upload: null },
            updatedBy: objectIdOf(current.id),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
      await recordAudit(
        {
          actorId: current.id,
          actorEmail: current.email,
          module: 'talent',
          action: 'update',
          record: { type: REMITTANCE_REPORT_RECORD_TYPE, id: report._id, label },
          before: { agency, month, version: report.version },
          after: auditAfter(report.version + 1),
          reason: REMITTANCE_REGENERATED_REASON,
        },
        { session },
      );
      return {
        reportId: report._id.toHexString(),
        version: report.version + 1,
        regenerated: true,
      };
    });
  } catch (error) {
    // Another generate for the same agency and month committed first.
    if (isDuplicateKey(error)) throw new ActionError(REMITTANCE_REPORT_CHANGED_MESSAGE);
    throw error;
  }
}

/** The contribution table versions the source runs stored, each once. */
function uniqueTableVersions(runs: readonly RemittanceRunRow[]): RemittanceSettingVersionRef[] {
  const keys = new Set([
    SSS_CONTRIBUTIONS_SETTING.key,
    PHILHEALTH_CONTRIBUTIONS_SETTING.key,
    PAGIBIG_CONTRIBUTIONS_SETTING.key,
  ]);
  const seen = new Set<string>();
  const result: RemittanceSettingVersionRef[] = [];
  for (const run of runs) {
    for (const version of run.settingVersions) {
      if (!keys.has(version.key)) continue;
      const id = `${version.key}:${version.effectiveFrom ?? ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({ key: version.key, effectiveFrom: version.effectiveFrom });
    }
  }
  return result;
}

export type { RemittanceMonth };
