import type { RemittanceUploadAgency } from '../agencies';
import type { RemittanceSnapshot } from '../types';

// Spec: docs/modules/talent.md#employer-contributions-and-remittances-build-step-211 ("Upload
// files"; decision 388 in docs/BUILD_PLAN.md) — one isolated upload format definition per agency:
// an id that names its version, the agency, the file type, whether it was checked against the
// agency's official file specification, the source it follows, and a pure `build(snapshot)`. When
// an official specification is obtained, a new definition with a new id replaces the current one
// in `CURRENT_REMITTANCE_FORMATS`; the old one stays for files already built.

/** The generated file types (Core's `saveGeneratedFile` accepts both, decision 389). */
export type RemittanceUploadContentType = 'text/plain' | 'text/csv';

export interface RemittanceFormatDefinition {
  /** `<agency>.<form>.<version>`, such as `sss.r3.assumed-2026-10`. */
  id: string;
  agency: RemittanceUploadAgency;
  /** "SSS R-3 contribution collection list (fixed-width text)". */
  label: string;
  contentType: RemittanceUploadContentType;
  extension: 'txt' | 'csv';
  /** False until checked against the agency's official file specification. */
  verified: boolean;
  /** What the layout follows. */
  source: string;
  /** The file's text: upper-case printable ASCII, every line ended with CR LF. */
  build(snapshot: RemittanceSnapshot): string;
}
