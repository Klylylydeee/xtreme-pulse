'use client';

import { useRef } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_MOBILE_MAX_LENGTH,
  CONTACT_POSITION_MAX_LENGTH,
  type FieldErrors,
  PERSON_NAME_MAX_LENGTH,
  PH_MOBILE_HELP,
  SUPPLIER_CONTACTS_MAX,
} from '@pulse/core';
import { Button } from '@pulse/ui/components/button';
import { FormField, Input } from '@pulse/ui/components/form';

// Spec: docs/modules/supply.md#suppliers — a supplier's contacts, kept on the supplier: at most 20,
// each with a name (required), position, email and mobile, checked like a client contact's. No
// primary flag. The rows are controlled, so the sheet sends them as a list; each field's error comes
// back keyed by its row (`contacts.0.email`).

/** One contact row in the sheet. `key` only keeps React's rows stable while rows are removed. */
export interface ContactRow {
  key: number;
  name: string;
  position: string;
  email: string;
  mobile: string;
}

type ContactField = Exclude<keyof ContactRow, 'key'>;

export function SupplierContactsFields({
  rows,
  onChange,
  errors,
  onRowsRemoved,
}: {
  rows: ContactRow[];
  onChange: (rows: ContactRow[]) => void;
  errors: FieldErrors;
  /** Called after a row is removed, since row-numbered errors no longer line up. */
  onRowsRemoved: () => void;
}) {
  const nextKey = useRef(rows.reduce((max, row) => Math.max(max, row.key), 0) + 1);
  const containerRef = useRef<HTMLDivElement>(null);
  const full = rows.length >= SUPPLIER_CONTACTS_MAX;

  function update(index: number, field: ContactField, value: string) {
    onChange(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  }

  function add() {
    const key = nextKey.current++;
    onChange([...rows, { key, name: '', position: '', email: '', mobile: '' }]);
    // Focus the new row's name once it renders.
    requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector<HTMLInputElement>(`[data-contact-key="${key}"] input[data-field="name"]`)
        ?.focus();
    });
  }

  function remove(index: number) {
    onChange(rows.filter((_, i) => i !== index));
    onRowsRemoved();
    // Keep focus in the section: the Add button, which is always there.
    requestAnimationFrame(() => {
      containerRef.current?.querySelector<HTMLButtonElement>('[data-add-contact]')?.focus();
    });
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="rounded-card bg-surface px-4 py-3 text-subheadline text-text-secondary shadow-card">
          No contacts yet.
        </p>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Contacts">
          {rows.map((row, index) => {
            const label = row.name.trim() || `Contact ${index + 1}`;
            const error = (field: ContactField) => errors[`contacts.${index}.${field}`];
            return (
              <li
                key={row.key}
                data-contact-key={row.key}
                className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
              >
                <div className="flex min-h-11 items-center justify-between gap-2 py-1 pr-1 pl-4">
                  <span className="truncate text-footnote font-semibold text-text-secondary">
                    Contact {index + 1}
                  </span>
                  <Button
                    variant="plain"
                    size="icon"
                    aria-label={`Remove ${label}`}
                    onClick={() => remove(index)}
                    className="hover:text-destructive-text"
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                <FormField label="Name" required error={error('name')}>
                  <Input
                    data-field="name"
                    value={row.name}
                    onChange={(event) => update(index, 'name', event.target.value)}
                    maxLength={PERSON_NAME_MAX_LENGTH}
                    autoComplete="off"
                    required
                  />
                </FormField>
                <FormField label="Position" error={error('position')}>
                  <Input
                    value={row.position}
                    onChange={(event) => update(index, 'position', event.target.value)}
                    maxLength={CONTACT_POSITION_MAX_LENGTH}
                    autoComplete="off"
                  />
                </FormField>
                <FormField label="Email" error={error('email')}>
                  <Input
                    type="email"
                    inputMode="email"
                    value={row.email}
                    onChange={(event) => update(index, 'email', event.target.value)}
                    maxLength={CONTACT_EMAIL_MAX_LENGTH}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </FormField>
                <FormField label="Mobile" hint={PH_MOBILE_HELP} error={error('mobile')}>
                  <Input
                    type="tel"
                    inputMode="tel"
                    value={row.mobile}
                    onChange={(event) => update(index, 'mobile', event.target.value)}
                    maxLength={CONTACT_MOBILE_MAX_LENGTH}
                    autoComplete="off"
                  />
                </FormField>
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4">
        <p className="text-footnote text-text-secondary">
          {full
            ? `A supplier has at most ${SUPPLIER_CONTACTS_MAX} contacts.`
            : `Optional. Up to ${SUPPLIER_CONTACTS_MAX} contacts.`}
        </p>
        <Button variant="tinted" data-add-contact onClick={add} disabled={full}>
          <Plus aria-hidden="true" className="size-5" />
          Add contact
        </Button>
      </div>
    </div>
  );
}
