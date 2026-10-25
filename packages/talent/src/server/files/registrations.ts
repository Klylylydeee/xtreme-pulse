import { connectDb } from '@pulse/db';
import { AccessDeniedError } from '@pulse/core';
import {
  employeeAuditLabel,
  getEmployeeIdentity,
  getSensitiveSubject,
  isApproverFor,
  registerFileAccess,
  type StoredFile,
} from '@pulse/core/server';
import { documentCategoryOf } from '../../fixed-sets';
import { REIMBURSEMENT_TYPE } from '../../reimbursements/views';
import { TIME_OFF_REQUEST_TYPE } from '../../time-off/kinds';
import { CERTIFICATION_TYPE, E_SIGNATURE_TYPE, EMPLOYEE_DOCUMENT_TYPE } from '../../views';
import { type CertificationRecord, CertificationModel } from '../certifications/model';
import { documentLabel } from '../documents/service';
import { type EmployeeDocumentRecord, EmployeeDocumentModel } from '../documents/model';
import { type ESignatureRecord, ESignatureModel } from '../e-signatures/model';
import {
  PAYROLL_RUN_EMPLOYEE_RECORD_TYPE,
  type PayrollRunDocument,
  type PayrollRunEmployeeDocument,
  PayrollRunEmployeeModel,
  PayrollRunModel,
} from '../payroll-runs/model';
import { PAYSLIP_FILE_TYPE } from '../payslips/service';
import { remittanceAuditLabel } from '../../remittance/agencies';
import { REMITTANCE_FILE_TYPE } from '../remittances/exports';
import {
  REMITTANCE_REPORT_RECORD_TYPE,
  type RemittanceReportDocument,
  RemittanceReportModel,
} from '../remittances/model';
import {
  canOpenCertificationAttachment,
  canOpenPayslip,
  canSeeDocumentCategory,
  canOpenTimeOffAttachment,
  canSeeESignatureImage,
  canSeeRemittances,
  canViewTimesheet,
} from '../policy';
import { type ReimbursementDocument, ReimbursementModel } from '../reimbursements/model';
import { objectIdOf } from '../shared';
import { type TimeOffRequestDocument, TimeOffRequestModel } from '../time-off/model';

// Spec: docs/ARCHITECTURE.md#file-storage ("Access by owner type", "Sensitive file views are
// audit-logged") and SECURITY.md#sensitive-data (decisions 175, 179, 181 and 182 in
// docs/BUILD_PLAN.md) — Talent's file access checks, registered by an explicit call: the file
// route calls `registerTalentFileAccess()` beside `registerCoreFileAccess()`.
//
// - `talent.employeeDocument`: a 201 document. Talent Read plus the reveal rule for its category
//   (`file201`, or `medical`, which Accounting doesn't get), or the employee's own. Every open is
//   audit-logged (`auditView`): a `reveal` entry with `fields: ['file']`, labelled
//   `<employee number> · <type label>`, written before any content is read.
// - `talent.eSignature`: the owner (any version) and the System Administrator only.
// - `talent.certification`: the current attachment of a live certification, for the employee,
//   Talent Read and the System Administrator, unlogged.
// - `talent.reimbursement` (build step 2.5, decision 248): the receipt of a live reimbursement
//   line, for whoever may open its timesheet (the employee, Talent Read or a `reportingTo`
//   supervisor), unlogged: a receipt isn't sensitive. A deleted line's or a replaced receipt
//   doesn't open.
// - `talent.timeOffRequest` (build step 2.8, decision 317): a leave request's attachment, treated
//   as a medical certificate, for the employee, HR or the System Administrator with Talent Read,
//   and the request's approvers (Core's `isApproverFor`), never Accounting as such. Every open is
//   audit-logged (`auditView`), labelled with the request's number (never its type, so a
//   confidential one stays hidden). A replaced attachment no longer opens.
// - `talent.payslip` (build step 2.10): a payslip PDF, only the file a finalized run's line points
//   at, for the employee (their own, outside module access) and Talent Read with HR, Accounting or
//   the System Administrator (`canOpenPayslip`); never a Board member as such or a supervisor.
//   Every open, the employee's own included, is audit-logged (`auditView`) as a `reveal` on
//   `talent.payrollRunEmployee` (field `file`), labelled `<run number> · <employee number>`.
//
// - `talent.remittanceReport` (build step 2.11, decision 387): a remittance report's exported PDF,
//   Excel or upload file, only a file the report's `files` points at (the current version's), for
//   Talent Read with HR, Accounting or the System Administrator (`canSeeRemittances`). Every open
//   is audit-logged (`auditView`) as a `reveal` on `talent.remittanceReport` (field `file`),
//   labelled `<agency> · <YYYY-MM>`.
//
// Each check reads the record the file belongs to and requires that record to point at this very
// file, so a replaced or stray file never opens through someone else's record.

async function timeOffRequestOf(file: StoredFile): Promise<TimeOffRequestDocument | null> {
  const ownerId = objectIdOf(file.ownerId);
  const fileId = objectIdOf(file.id);
  if (!ownerId || !fileId) return null;
  await connectDb();
  return TimeOffRequestModel.findOne({
    _id: ownerId,
    attachmentFileId: fileId,
  }).lean<TimeOffRequestDocument>();
}

async function documentOf(file: StoredFile): Promise<EmployeeDocumentRecord | null> {
  const ownerId = objectIdOf(file.ownerId);
  const fileId = objectIdOf(file.id);
  if (!ownerId || !fileId) return null;
  await connectDb();
  return EmployeeDocumentModel.findOne({ _id: ownerId, fileId }).lean<EmployeeDocumentRecord>();
}

type PayslipLine = Pick<PayrollRunEmployeeDocument, '_id' | 'employeeId' | 'runId'>;

/** The finalized run's line a payslip file belongs to, when the line points at this very file. */
async function payslipLineOf(
  file: StoredFile,
): Promise<{ line: PayslipLine; runNumber: string } | null> {
  const ownerId = objectIdOf(file.ownerId);
  const fileId = objectIdOf(file.id);
  if (!ownerId || !fileId) return null;
  await connectDb();
  const line = await PayrollRunEmployeeModel.findOne(
    { _id: ownerId, 'payslip.fileId': fileId },
    { employeeId: 1, runId: 1 },
  ).lean<PayslipLine>();
  if (!line) return null;
  const run = await PayrollRunModel.findOne(
    { _id: line.runId, status: 'finalized' },
    { number: 1 },
  ).lean<Pick<PayrollRunDocument, '_id' | 'number'>>();
  return run ? { line, runNumber: run.number } : null;
}

type RemittanceFileReport = Pick<RemittanceReportDocument, '_id' | 'agency' | 'month'>;

/** The report an exported file belongs to, when its current `files` point at this very file. */
async function remittanceReportOf(file: StoredFile): Promise<RemittanceFileReport | null> {
  const ownerId = objectIdOf(file.ownerId);
  const fileId = objectIdOf(file.id);
  if (!ownerId || !fileId) return null;
  await connectDb();
  return RemittanceReportModel.findOne(
    {
      _id: ownerId,
      $or: [{ 'files.pdf': fileId }, { 'files.xlsx': fileId }, { 'files.upload': fileId }],
    },
    { agency: 1, month: 1 },
  ).lean<RemittanceFileReport>();
}

let registered = false;

/**
 * Registers Talent's file access checks (`talent.employeeDocument` with its audited views,
 * `talent.eSignature`, `talent.certification`, `talent.reimbursement`, `talent.timeOffRequest`
 * with its audited views, from step 2.10 `talent.payslip` with its audited views, and from step 2.11
 * `talent.remittanceReport` with its audited views). Safe to call on every request: it registers once per process (per
 * bundle in Next).
 */
export function registerTalentFileAccess(): void {
  if (registered) return;

  registerFileAccess(
    EMPLOYEE_DOCUMENT_TYPE,
    async (user, file) => {
      const document = await documentOf(file);
      if (!document) return false;
      const subject = await getSensitiveSubject(document.employeeId);
      if (!subject) return false;
      return canSeeDocumentCategory(user, documentCategoryOf(document.type), subject);
    },
    {
      auditView: {
        module: 'talent',
        async record(file) {
          const document = await documentOf(file);
          if (!document) throw new Error('The 201 document for this file is missing.');
          const employee = await employeeAuditLabel(document.employeeId);
          return {
            type: EMPLOYEE_DOCUMENT_TYPE,
            id: document._id,
            label: employee ? documentLabel(employee.employeeNumber, document.type) : null,
          };
        },
      },
    },
  );

  registerFileAccess(E_SIGNATURE_TYPE, async (user, file) => {
    const ownerId = objectIdOf(file.ownerId);
    const fileId = objectIdOf(file.id);
    if (!ownerId || !fileId) return false;
    await connectDb();
    const signature = await ESignatureModel.findOne({
      _id: ownerId,
      fileId,
    }).lean<ESignatureRecord>();
    return signature ? canSeeESignatureImage(user, signature.employeeId.toHexString()) : false;
  });

  registerFileAccess(CERTIFICATION_TYPE, async (user, file) => {
    const ownerId = objectIdOf(file.ownerId);
    const fileId = objectIdOf(file.id);
    if (!ownerId || !fileId) return false;
    await connectDb();
    // Removed certifications drop out of this query (soft delete).
    const certification = await CertificationModel.findOne({
      _id: ownerId,
      attachmentFileId: fileId,
    }).lean<CertificationRecord>();
    return certification
      ? canOpenCertificationAttachment(user, certification.employeeId.toHexString())
      : false;
  });

  registerFileAccess(REIMBURSEMENT_TYPE, async (user, file) => {
    const ownerId = objectIdOf(file.ownerId);
    const fileId = objectIdOf(file.id);
    if (!ownerId || !fileId) return false;
    await connectDb();
    // Deleted lines drop out of this query (soft delete); a replaced receipt no longer matches.
    const line = await ReimbursementModel.findOne(
      { _id: ownerId, receiptFileId: fileId },
      { employeeId: 1 },
    ).lean<Pick<ReimbursementDocument, '_id' | 'employeeId'>>();
    if (!line) return false;
    try {
      const identity = await getEmployeeIdentity(user, line.employeeId.toHexString(), {
        separated: true,
      });
      return identity ? canViewTimesheet(user, identity) : false;
    } catch (error) {
      // Core refuses a viewer who is neither the employee, Talent Read nor a supervisor.
      if (error instanceof AccessDeniedError) return false;
      throw error;
    }
  });

  registerFileAccess(
    TIME_OFF_REQUEST_TYPE,
    async (user, file) => {
      const request = await timeOffRequestOf(file);
      if (!request) return false;
      const employeeId = request.employeeId.toHexString();
      if (canOpenTimeOffAttachment(user, employeeId)) return true;
      const approver = await isApproverFor(
        user.id,
        TIME_OFF_REQUEST_TYPE,
        request._id.toHexString(),
      );
      return canOpenTimeOffAttachment(user, employeeId, { approver });
    },
    {
      auditView: {
        module: 'talent',
        async record(file) {
          const request = await timeOffRequestOf(file);
          if (!request) throw new Error('The time off request for this file is missing.');
          const employee = await employeeAuditLabel(request.employeeId);
          return {
            type: TIME_OFF_REQUEST_TYPE,
            id: request._id,
            label: employee ? `${employee.employeeNumber} · ${request.number}` : request.number,
          };
        },
      },
    },
  );

  registerFileAccess(
    PAYSLIP_FILE_TYPE,
    async (user, file) => {
      const found = await payslipLineOf(file);
      return found ? canOpenPayslip(user, found.line.employeeId.toHexString()) : false;
    },
    {
      auditView: {
        module: 'talent',
        async record(file) {
          const found = await payslipLineOf(file);
          if (!found) throw new Error('The payroll run line for this payslip is missing.');
          const employee = await employeeAuditLabel(found.line.employeeId);
          return {
            type: PAYROLL_RUN_EMPLOYEE_RECORD_TYPE,
            id: found.line._id,
            label: employee ? `${found.runNumber} · ${employee.employeeNumber}` : found.runNumber,
          };
        },
      },
    },
  );

  registerFileAccess(
    REMITTANCE_FILE_TYPE,
    async (user, file) => {
      // The viewer first, so one who may not see remittances never reads the report.
      if (!canSeeRemittances(user)) return false;
      return (await remittanceReportOf(file)) !== null;
    },
    {
      auditView: {
        module: 'talent',
        async record(file) {
          const report = await remittanceReportOf(file);
          if (!report) throw new Error('The remittance report for this file is missing.');
          return {
            type: REMITTANCE_REPORT_RECORD_TYPE,
            id: report._id,
            label: remittanceAuditLabel(report.agency, report.month),
          };
        },
      },
    },
  );

  registered = true;
}
