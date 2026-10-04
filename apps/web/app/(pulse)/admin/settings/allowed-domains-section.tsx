'use client';

import { type FormEvent, useState, useTransition } from 'react';
import { AtSign, Plus } from 'lucide-react';
import { type ActionResult, fieldError } from '@pulse/core';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { FormField, FormSection, Input } from '@pulse/ui/components/form';
import { FormAlert } from '@/components/form-alert';
import {
  addAllowedEmailDomainAction,
  removeAllowedEmailDomainAction,
} from '@/lib/actions/company-settings';
import { SavedNote, SectionHeading } from './settings-ui';

export interface AllowedDomainRow {
  id: string;
  domain: string;
  userCount: number;
}

function usersOn(count: number): string {
  return count === 1 ? '1 user' : `${count.toLocaleString('en-PH')} users`;
}

function RemoveDomain({ row }: { row: AllowedDomainRow }) {
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setError(null);
    const outcome = await removeAllowedEmailDomainAction(null, { id: row.id });
    if (!outcome.ok) {
      setError(
        outcome.formError ?? outcome.fieldErrors.id ?? 'The domain wasn’t removed. Try again.',
      );
      // Keeps the dialog open with the error.
      throw new Error('Not removed');
    }
  }

  return (
    <DestructiveConfirmDialog
      trigger={
        <Button
          variant="plain"
          className="text-destructive-text hover:text-destructive-text"
          aria-label={`Remove ${row.domain}`}
        >
          Remove
        </Button>
      }
      onOpenChange={(open) => {
        if (open) setError(null);
      }}
      title={`Remove ${row.domain}?`}
      description={
        row.userCount === 0
          ? 'No users are on this domain. Nobody with an email on it can sign in once it is removed. You can add it again later.'
          : `${usersOn(row.userCount)} ${row.userCount === 1 ? 'is' : 'are'} on this domain. They can’t sign in once it is removed, until it is added again.`
      }
      confirmLabel="Remove domain"
      onConfirm={remove}
      error={error}
    />
  );
}

/**
 * The allowed email domains: who can sign in. Each row shows how many users are on the domain;
 * Remove asks first and names that count. The service refuses removing the last domain or the
 * System Administrator's own; that message shows in the dialog. Adding a removed domain restores it.
 */
export function AllowedDomainsSection({
  domains,
  ownDomain,
}: {
  domains: AllowedDomainRow[];
  /** The signed-in System Administrator's own email domain, labeled in the list. */
  ownDomain: string;
}) {
  const [result, setResult] = useState<ActionResult<{ domain: string }> | null>(null);
  const [adding, startAdding] = useTransition();
  const added = result?.ok ? result.data.domain : null;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    // Submitted by hand, not through the form's `action`, so a refused domain stays in the box.
    startAdding(async () => {
      const outcome = await addAllowedEmailDomainAction(null, formData);
      setResult(outcome);
      if (outcome.ok) form.reset();
    });
  }

  return (
    <section aria-labelledby="allowed-domains-title" className="flex flex-col gap-4">
      <SectionHeading id="allowed-domains-title" title="Allowed email domains">
        Only people with an email on one of these domains can sign in.
      </SectionHeading>
      <FormSection title="Domains">
        {domains.length === 0 ? (
          <EmptyState
            variant="inline"
            headingLevel={3}
            icon={<AtSign strokeWidth={1.75} />}
            title="No allowed domains"
            description="Nobody can sign in until a domain is added. Add the company’s email domain below."
          />
        ) : (
          <ul
            aria-label="Allowed email domains"
            className="flex flex-col divide-y divide-separator"
          >
            {domains.map((row) => (
              <li key={row.id} className="flex min-h-14 items-center gap-3 py-1.5 pr-2 pl-4">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-body md:text-subheadline">{row.domain}</span>
                  <span className="text-footnote text-text-secondary">
                    {usersOn(row.userCount)}
                    {row.domain === ownDomain ? ' · Your domain' : ''}
                  </span>
                </div>
                <RemoveDomain row={row} />
              </li>
            ))}
          </ul>
        )}
      </FormSection>
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <FormAlert message={result && !result.ok ? result.formError : null} />
        <FormSection
          title="Add a domain"
          footer="Type the part after the @, for example xtreme-works.com. A domain removed before is restored."
        >
          <FormField label="Domain" error={fieldError(result, 'domain')} required>
            <Input
              name="domain"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="xtreme-works.com"
              maxLength={253}
              required
            />
          </FormField>
        </FormSection>
        <div className="flex flex-col-reverse items-stretch gap-3 px-4 sm:flex-row sm:items-center sm:justify-end">
          <SavedNote show={!!added && !adding}>{added} added.</SavedNote>
          <Button type="submit" variant="tinted" loading={adding}>
            <Plus aria-hidden="true" strokeWidth={1.75} />
            Add domain
          </Button>
        </div>
      </form>
    </section>
  );
}
