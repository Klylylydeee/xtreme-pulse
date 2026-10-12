import { connectDb } from '@pulse/db';
import {
  employeeAuditLabel,
  getSensitiveSubject,
  registerFileAccess,
  type StoredFile,
} from '@pulse/core/server';
import { documentCategoryOf } from '../../fixed-sets';
import { CERTIFICATION_TYPE, E_SIGNATURE_TYPE, EMPLOYEE_DOCUMENT_TYPE } from '../../views';
import { type CertificationRecord, CertificationModel } from '../certifications/model';
import { documentLabel } from '../documents/service';
import { type EmployeeDocumentRecord, EmployeeDocumentModel } from '../documents/model';
import { type ESignatureRecord, ESignatureModel } from '../e-signatures/model';
import {
  canOpenCertificationAttachment,
  canSeeDocumentCategory,
  canSeeESignatureImage,
} from '../policy';
import { objectIdOf } from '../shared';

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
//
// Each check reads the record the file belongs to and requires that record to point at this very
// file, so a replaced or stray file never opens through someone else's record.

async function documentOf(file: StoredFile): Promise<EmployeeDocumentRecord | null> {
  const ownerId = objectIdOf(file.ownerId);
  const fileId = objectIdOf(file.id);
  if (!ownerId || !fileId) return null;
  await connectDb();
  return EmployeeDocumentModel.findOne({ _id: ownerId, fileId }).lean<EmployeeDocumentRecord>();
}

let registered = false;

/**
 * Registers Talent's file access checks (`talent.employeeDocument` with its audited views,
 * `talent.eSignature` and `talent.certification`). Safe to call on every request: it registers
 * once per process (per bundle in Next).
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

  registered = true;
}
