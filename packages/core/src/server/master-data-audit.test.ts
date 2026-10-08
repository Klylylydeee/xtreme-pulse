import { describe, expect, it } from 'vitest';
import { AUDIT_LABEL_MAX_LENGTH } from '../audit';
import { emptyModuleAccess } from '../module-access';
import { auditActor, auditLabel } from './master-data-audit';

// docs/TESTING.md#master-data-tests — audit labels that join two names stay within the audit
// log's label limit.

describe('auditLabel', () => {
  it('joins the parts with a middle dot', () => {
    expect(auditLabel('Acme')).toBe('Acme');
    expect(auditLabel('Acme', 'Makati office')).toBe('Acme · Makati office');
  });

  it('keeps a label at the limit as it is', () => {
    const label = auditLabel('a'.repeat(AUDIT_LABEL_MAX_LENGTH));
    expect(label).toHaveLength(AUDIT_LABEL_MAX_LENGTH);
    expect(label.endsWith('…')).toBe(false);
  });

  it('cuts a longer label to the limit with an ellipsis', () => {
    // A 100-character product name and a 100-character part number: 203 characters joined.
    const label = auditLabel('P'.repeat(100), 'N'.repeat(100));
    expect(label).toHaveLength(AUDIT_LABEL_MAX_LENGTH);
    expect(label.startsWith(`${'P'.repeat(100)} · N`)).toBe(true);
    expect(label.endsWith('…')).toBe(true);
  });
});

describe('auditActor', () => {
  it('takes only the id and email', () => {
    expect(
      auditActor({ id: 'u1', email: 'a@example.com', moduleAccess: emptyModuleAccess() }),
    ).toEqual({ actorId: 'u1', actorEmail: 'a@example.com' });
  });
});
