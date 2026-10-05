import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { ScrollText } from 'lucide-react';
import { ActionError, auditFiltersSchema } from '@pulse/core';
import { type AuditPage, listAuditEntries } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { ErrorState } from '@pulse/ui/components/error-state';
import { PageHeader } from '@pulse/ui/components/page-header';
import { KeysetPager } from '@/components/keyset-pager';
import { requireAdminPage } from '@/lib/auth';
import {
  firstPageHref,
  firstParam,
  pagingLinks,
  readPaging,
  type SearchParams,
} from '@/lib/keyset-paging';
import { AuditFilterForm, type AuditFilterValues } from './audit-filters';
import { AuditLogLoading } from './audit-log-loading';
import { AuditLogTable } from './audit-log-table';

export const metadata: Metadata = { title: 'Audit log' };

/** Entries per page. */
const PAGE_SIZE = 50;

const FILTER_NAMES = [
  'from',
  'to',
  'actorId',
  'module',
  'action',
  'recordType',
  'recordId',
] as const satisfies readonly (keyof AuditFilterValues)[];

// Spec: docs/modules/core.md#audit-log — the append-only audit log, newest first, filtered by Manila
// date range, actor, module, action, and record type and id. The System Administrator only; anyone
// else, HR included, gets the no-access state (HTTP 403). The guard comes first, before anything
// that can suspend; the entries load inside the page's own boundary
// (docs/CODE_STYLE.md#pages-server-actions-and-route-handlers). Viewing it is not audit-logged.
export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireAdminPage('systemAdministrator');
  return (
    <Suspense fallback={<AuditLogLoading />}>
      <AuditLog searchParams={searchParams} />
    </Suspense>
  );
}

async function AuditLog({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;

  const values = Object.fromEntries(
    FILTER_NAMES.map((name) => [name, (firstParam(params, name) ?? '').trim()]),
  ) as AuditFilterValues;
  const activeCount = FILTER_NAMES.filter((name) => values[name] !== '').length;
  const parsed = auditFiltersSchema.safeParse(values);
  const errors: Partial<Record<keyof AuditFilterValues, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof AuditFilterValues | undefined;
      if (field && !errors[field]) errors[field] = issue.message;
    }
  }

  const paging = readPaging(params);
  let page: AuditPage | null = null;
  let stale = paging.invalid;
  if (parsed.success && !paging.invalid) {
    try {
      page = await listAuditEntries(parsed.data, { cursor: paging.cursor, limit: PAGE_SIZE });
    } catch (error) {
      // A cursor this app didn't make (an edited or very old link).
      if (!(error instanceof ActionError)) throw error;
      stale = true;
    }
  }
  const links = page ? pagingLinks('/admin/audit', params, paging, page.nextCursor) : null;
  const clearFilters = (
    <Button asChild variant="tinted">
      <Link href="/admin/audit">Clear filters</Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every change, reveal and password change, newest first. Times are Manila time."
      />
      <AuditFilterForm values={values} errors={errors} activeCount={activeCount} />
      {stale ? (
        <ErrorState
          title="This page link is out of date"
          description="Go back to the newest entries."
          action={
            <Button asChild variant="tinted">
              <Link href={firstPageHref('/admin/audit', params)}>Go to the newest</Link>
            </Button>
          }
        />
      ) : !page ? (
        <EmptyState
          icon={<ScrollText strokeWidth={1.75} />}
          title="Check the filters"
          description="Fix the highlighted filters to see entries."
          action={clearFilters}
        />
      ) : page.entries.length === 0 ? (
        activeCount > 0 ? (
          <EmptyState
            icon={<ScrollText strokeWidth={1.75} />}
            title="No audit entries match these filters"
            description="Try a wider date range or fewer filters."
            action={clearFilters}
          />
        ) : (
          <EmptyState
            icon={<ScrollText strokeWidth={1.75} />}
            title="No audit entries yet"
            description="Changes, reveals and password changes will show up here."
          />
        )
      ) : (
        <>
          <AuditLogTable entries={page.entries} />
          {links ? (
            <KeysetPager newer={links.newer} older={links.older} label="Audit log pages" />
          ) : null}
        </>
      )}
    </>
  );
}
