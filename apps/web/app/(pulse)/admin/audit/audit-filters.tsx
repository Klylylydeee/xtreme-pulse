'use client';

import { useId, useState } from 'react';
import Form from 'next/form';
import Link from 'next/link';
import { SlidersHorizontal } from 'lucide-react';
import { AUDIT_ACTIONS, AUDIT_MODULES } from '@pulse/core';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { FormField, Input, Select } from '@pulse/ui/components/form';
import { auditActionLabel, moduleDisplay } from '@/lib/module-labels';

// Spec: docs/modules/core.md#audit-log — the audit log's filters. They live in the URL (a GET
// form), so a filtered view can be bookmarked or shared; the page validates them with
// `auditFiltersSchema`. Applying them starts again from the newest entry.

export type AuditFilterValues = Record<
  'from' | 'to' | 'actorId' | 'module' | 'action' | 'recordType' | 'recordId',
  string
>;

export function AuditFilterForm({
  values,
  errors,
  activeCount,
}: {
  /** As typed in the URL, so a value that failed validation is shown with its error. */
  values: AuditFilterValues;
  errors: Partial<Record<keyof AuditFilterValues, string>>;
  /** How many filters are set. */
  activeCount: number;
}) {
  const hasErrors = Object.keys(errors).length > 0;
  // Phones keep the filters behind a button; wider screens always show them.
  const [open, setOpen] = useState(hasErrors);
  const panelId = useId();

  return (
    <section aria-label="Filters" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 md:hidden">
        <Button
          variant="secondary"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
        >
          <SlidersHorizontal aria-hidden="true" className="size-4.5" />
          {open ? 'Hide filters' : 'Filters'}
          {activeCount > 0 ? <span className="numeric">({activeCount})</span> : null}
        </Button>
        {activeCount > 0 ? (
          <Button asChild variant="plain" className="text-accent">
            <Link href="/admin/audit">Clear filters</Link>
          </Button>
        ) : null}
      </div>
      <Form
        id={panelId}
        action="/admin/audit"
        className={cn(
          'flex-col gap-4 rounded-card bg-surface p-2 shadow-card md:flex md:p-3',
          open ? 'flex' : 'hidden',
        )}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
          <FormField label="From" error={errors.from}>
            <Input type="date" name="from" defaultValue={values.from} />
          </FormField>
          <FormField label="To" error={errors.to}>
            <Input type="date" name="to" defaultValue={values.to} />
          </FormField>
          <FormField label="Module" error={errors.module}>
            <Select name="module" defaultValue={values.module}>
              <option value="">Any module</option>
              {AUDIT_MODULES.map((module) => (
                <option key={module} value={module}>
                  {moduleDisplay(module).title}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Action" error={errors.action}>
            <Select name="action" defaultValue={values.action}>
              <option value="">Any action</option>
              {AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {auditActionLabel(action)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField
            label="Actor ID"
            hint="Or open an entry and choose Show this actor’s entries."
            error={errors.actorId}
          >
            <Input
              name="actorId"
              defaultValue={values.actorId}
              autoComplete="off"
              spellCheck={false}
              className="numeric"
            />
          </FormField>
          <FormField label="Record type" hint="For example core.user" error={errors.recordType}>
            <Input
              name="recordType"
              defaultValue={values.recordType}
              autoComplete="off"
              spellCheck={false}
            />
          </FormField>
          <FormField label="Record ID" error={errors.recordId}>
            <Input
              name="recordId"
              defaultValue={values.recordId}
              autoComplete="off"
              spellCheck={false}
              className="numeric"
            />
          </FormField>
          <div className="flex flex-wrap items-end gap-x-1 gap-y-2 px-4 py-3">
            <Button type="submit" variant="tinted">
              Apply filters
            </Button>
            {activeCount > 0 ? (
              <Button asChild variant="plain" className="hidden text-accent md:inline-flex">
                <Link href="/admin/audit">Clear filters</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </Form>
    </section>
  );
}
