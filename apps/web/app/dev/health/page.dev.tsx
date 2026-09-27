import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, CircleX, FileSpreadsheet, FileText } from 'lucide-react';
import { formatDateTime } from '@pulse/core';
import {
  checkEncryption,
  checkRedis,
  checkSharedHelpers,
  checkStorage,
  currentFileUploadSettings,
  DEFAULT_FILE_UPLOAD_SETTINGS,
  type DevJobChecks,
  type EncryptionHealth,
  type FileUploadSettings,
  type HelperGroup,
  type RedisHealth,
  runDevJobChecks,
  type StorageHealth,
  type StoredFile,
  UPLOAD_TYPES,
} from '@pulse/core/server';
import { checkDatabase, type DatabaseHealth } from '@pulse/db';
import { ErrorState } from '@pulse/ui/components/error-state';
import { UploadForm } from './upload-form';

export const metadata: Metadata = {
  title: 'Health',
};

type RowState = 'ok' | 'fail' | 'info';

interface Row {
  label: string;
  value: string;
  state: RowState;
  /**
   * `anywhere` lets the value break at any character, for long values with no spaces (a folder
   * path) that would otherwise push the page sideways at phone width. Default: between words only.
   */
  wrap?: 'words' | 'anywhere';
}

const STATE_ICON = {
  ok: (
    <CircleCheck
      aria-hidden="true"
      className="size-5 shrink-0 text-success-text"
      strokeWidth={1.75}
    />
  ),
  fail: (
    <CircleX
      aria-hidden="true"
      className="size-5 shrink-0 text-destructive-text"
      strokeWidth={1.75}
    />
  ),
  // An empty slot the size of an icon, so info values line up with checked ones.
  info: <span aria-hidden="true" className="size-5 shrink-0" />,
} satisfies Record<RowState, ReactNode>;

function databaseRows(health: Extract<DatabaseHealth, { status: 'connected' }>): Row[] {
  const onReplicaSet = health.replicaSet !== null;
  return [
    { label: 'MongoDB', value: 'Connected', state: 'ok' },
    { label: 'Database', value: health.databaseName, state: 'info' },
    { label: 'Server version', value: health.serverVersion, state: 'info' },
    {
      label: 'Replica set',
      value: health.replicaSet ?? 'None (standalone server)',
      state: onReplicaSet ? 'ok' : 'fail',
    },
    {
      label: 'Test transaction',
      value: health.transactionCommitted ? 'Committed' : 'Not committed',
      state: health.transactionCommitted ? 'ok' : 'fail',
    },
    {
      label: 'Rollback',
      value: health.transactionRolledBack ? 'Rolled back' : 'Not rolled back',
      state: health.transactionRolledBack ? 'ok' : 'fail',
    },
  ];
}

/**
 * Text that wraps only between words, never inside one: dates, numbers and timestamps stay whole
 * (a hyphen would otherwise allow "2025-" / "12-31").
 */
function Words({ text }: { text: string }) {
  return text.split(/(\s+)/).map((part, index) =>
    /^\s+$/.test(part) ? (
      part
    ) : (
      <span key={index} className="whitespace-nowrap">
        {part}
      </span>
    ),
  );
}

function CheckList({ id, title, rows }: { id: string; title: string; rows: Row[] }) {
  return (
    <section className="flex flex-col gap-2" aria-labelledby={id}>
      <h2 id={id} className="px-4 text-footnote text-text-secondary uppercase">
        {title}
      </h2>
      <dl className="divide-y divide-separator rounded-card bg-surface shadow-card">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2"
          >
            <dt className="text-body">
              <Words text={row.label} />
            </dt>
            {/* At phone width a long value moves under its label instead of breaking mid-word. */}
            <dd className="ml-auto flex min-w-0 items-center justify-end gap-2 text-body text-text-secondary">
              {row.wrap === 'anywhere' ? (
                <span className="min-w-0 text-right wrap-anywhere">{row.value}</span>
              ) : (
                <span className="text-right">
                  <Words text={row.value} />
                </span>
              )}
              {STATE_ICON[row.state]}
              {row.state === 'info' ? null : (
                <span className="sr-only">{row.state === 'ok' ? 'Passed' : 'Failed'}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 px-4 text-subheadline text-destructive-text">
      <CircleAlert aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

function HelperSection({ group, index }: { group: HelperGroup; index: number }) {
  const rows: Row[] = group.checks.map((check) => ({
    label: check.label,
    value: check.value,
    state: check.ok === null ? 'info' : check.ok ? 'ok' : 'fail',
  }));
  return (
    <div className="flex flex-col gap-2">
      <CheckList id={`health-helpers-${index}`} title={group.title} rows={rows} />
      {group.error ? <ErrorLine message={group.error} /> : null}
    </div>
  );
}

function DatabaseSection({ health }: { health: DatabaseHealth }) {
  switch (health.status) {
    case 'not-configured':
      return (
        <ErrorState
          title="Database not configured"
          description="Set MONGODB_URI in .env.local at the repo root, start your local MongoDB replica set (see Getting started in README.md), then reload this page."
        />
      );
    case 'unreachable':
      return (
        <ErrorState
          title="Can’t reach MongoDB"
          description={`Check that your local MongoDB replica set is running (see Getting started in README.md) and that MONGODB_URI points to it. ${health.error}`}
        />
      );
    case 'connected':
      return (
        <>
          <CheckList id="health-database" title="Database" rows={databaseRows(health)} />
          {health.error ? <ErrorLine message={health.error} /> : null}
        </>
      );
  }
}

function EncryptionSection({ health }: { health: EncryptionHealth | null }) {
  if (!health) {
    return (
      <CheckList
        id="health-encryption"
        title="Field encryption"
        rows={[{ label: 'Field encryption', value: 'Needs the database', state: 'info' }]}
      />
    );
  }
  switch (health.status) {
    case 'not-configured':
      return (
        <ErrorState
          title="Field encryption not configured"
          description="Set FIELD_ENCRYPTION_LOCAL_KEY in .env.local at the repo root to 96 random bytes, base64-encoded, then restart pnpm dev."
        />
      );
    case 'invalid-key':
      return (
        <ErrorState
          title="Field encryption key is invalid"
          description="FIELD_ENCRYPTION_LOCAL_KEY must be 96 random bytes, base64-encoded (128 characters). Fix it in .env.local, then restart pnpm dev."
        />
      );
    case 'checked': {
      const rows: Row[] = health.checks.map((check) => ({
        label: check.label,
        value: check.value,
        state: check.ok === null ? 'info' : check.ok ? 'ok' : 'fail',
        wrap: check.breakAnywhere ? 'anywhere' : 'words',
      }));
      return (
        <div className="flex flex-col gap-2">
          <CheckList id="health-encryption" title="Field encryption" rows={rows} />
          {health.error ? <ErrorLine message={health.error} /> : null}
        </div>
      );
    }
  }
}

function formatBytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function uploadLimitsText(settings: FileUploadSettings): string {
  const types = settings.allowedTypes.map((type) => UPLOAD_TYPES[type].extension.toUpperCase());
  return `${types.join(', ')}, up to ${formatBytes(settings.maxSizeBytes)}`;
}

function StorageSection({
  storage,
  settings,
}: {
  storage: StorageHealth;
  settings: FileUploadSettings;
}) {
  const rows: Row[] = [
    {
      label: 'Folder',
      value: storage.root ?? 'Not resolved',
      state: storage.root ? 'info' : 'fail',
      wrap: storage.root ? 'anywhere' : 'words',
    },
    {
      label: 'Write and read',
      value: storage.writable ? 'Working' : 'Failed',
      state: storage.writable ? 'ok' : 'fail',
    },
    { label: 'Uploads allowed', value: uploadLimitsText(settings), state: 'info' },
  ];
  return (
    <div className="flex flex-col gap-2">
      <CheckList id="health-storage" title="File storage" rows={rows} />
      {storage.error ? <ErrorLine message={storage.error} /> : null}
    </div>
  );
}

function jobStateRow(label: string, run: DevJobChecks['testJob'] | null): Row {
  if (!run) return { label, value: 'Needs the database', state: 'info' };
  switch (run.state) {
    case 'completed':
      return { label, value: `Completed in ${run.ms} ms`, state: 'ok' };
    case 'failed':
      return { label, value: `Failed: ${run.error}`, state: 'fail' };
    case 'waiting':
      return { label, value: run.detail, state: 'fail' };
    case 'error':
      return { label, value: run.error, state: 'fail' };
  }
}

function RedisSection({ redis, jobs }: { redis: RedisHealth; jobs: DevJobChecks | null }) {
  switch (redis.status) {
    case 'not-configured':
      return (
        <ErrorState
          title="Background jobs not configured"
          description="Set REDIS_URL in .env.local at the repo root, start your local Redis (see Getting started in README.md), then restart pnpm dev."
        />
      );
    case 'unreachable':
      return (
        <ErrorState
          title="Can’t reach Redis"
          description={`Check that your local Redis is running (see Getting started in README.md) and that REDIS_URL points to it. ${redis.error}`}
        />
      );
    case 'refused':
      return redis.problem === 'login' ? (
        <ErrorState
          title="Redis refused the login"
          description="Check the user name and password in REDIS_URL in .env.local, then restart pnpm dev."
        />
      ) : (
        <ErrorState
          title="Redis user can’t run background jobs"
          description="The user in REDIS_URL can’t run scripts that write keys, which BullMQ needs. Give it access to scripting and to the pulse:* keys, or use a user that has it."
        />
      );
    case 'connected': {
      const rows: Row[] = [
        { label: 'Redis', value: 'Connected', state: 'ok' },
        { label: 'Server version', value: redis.serverVersion, state: 'info' },
        {
          label: 'Eviction policy',
          value: redis.evictionPolicy ?? 'Unknown',
          // BullMQ loses jobs if Redis evicts keys.
          state:
            redis.evictionPolicy === null
              ? 'info'
              : redis.evictionPolicy === 'noeviction'
                ? 'ok'
                : 'fail',
        },
        redis.worker
          ? {
              label: 'Worker',
              value: `Running since ${formatDateTime(redis.worker.startedAt)} (process ${redis.worker.pid})`,
              state: 'ok',
            }
          : { label: 'Worker', value: 'Not running. Start it with pnpm dev.', state: 'fail' },
      ];
      if (jobs) rows.push(jobStateRow('Test job', jobs.testJob));
      const schedules: Row[] = redis.schedules.map((schedule) => ({
        label: schedule.id,
        value: `${schedule.pattern ?? 'No pattern'} (${schedule.timeZone ?? 'no time zone'})${
          schedule.nextRunAt ? ` · next ${formatDateTime(schedule.nextRunAt)}` : ''
        }`,
        state: schedule.timeZone === 'Asia/Manila' ? 'ok' : 'fail',
      }));
      return (
        <>
          <div className="flex flex-col gap-2">
            <CheckList id="health-jobs" title="Background jobs" rows={rows} />
            {redis.error ? <ErrorLine message={redis.error} /> : null}
          </div>
          <CheckList
            id="health-schedules"
            title="Schedules"
            rows={
              schedules.length
                ? schedules
                : [{ label: 'Schedules', value: 'None registered', state: 'info' }]
            }
          />
        </>
      );
    }
  }
}

function FileLink({ file, kind }: { file: StoredFile | null; kind: 'PDF' | 'Excel' }) {
  const Icon = kind === 'PDF' ? FileText : FileSpreadsheet;
  return (
    <div className="flex min-h-11 items-center gap-3 px-4 py-2">
      <Icon aria-hidden="true" className="size-5 shrink-0 text-text-secondary" strokeWidth={1.75} />
      {file ? (
        <a
          href={file.url}
          className="min-w-0 text-body font-medium text-accent underline-offset-2 hover:underline"
        >
          {/* Wraps between words only, so a date in the name stays whole. */}
          <Words text={`Download ${file.originalName}`} />
        </a>
      ) : (
        <span className="text-body text-text-secondary">Sample {kind} file not generated</span>
      )}
    </div>
  );
}

function SampleFilesSection({ jobs }: { jobs: DevJobChecks }) {
  if (!jobs.sampleFiles) return null;
  const row = jobStateRow('Export job', jobs.sampleExports);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="health-exports">
      <h2 id="health-exports" className="px-4 text-footnote text-text-secondary uppercase">
        Sample exports
      </h2>
      <div className="divide-y divide-separator rounded-card bg-surface shadow-card">
        <dl>
          <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2">
            <dt className="text-body">{row.label}</dt>
            <dd className="ml-auto flex items-center justify-end gap-2 text-body text-text-secondary">
              <span className="text-right">
                <Words text={row.value} />
              </span>
              {STATE_ICON[row.state]}
              {row.state === 'info' ? null : (
                <span className="sr-only">{row.state === 'ok' ? 'Passed' : 'Failed'}</span>
              )}
            </dd>
          </div>
        </dl>
        <FileLink file={jobs.sampleFiles.pdf} kind="PDF" />
        <FileLink file={jobs.sampleFiles.xlsx} kind="Excel" />
      </div>
    </section>
  );
}

export default async function DevHealthPage() {
  // Run the checks on every request, never at build time.
  await connection();
  const health = await checkDatabase();
  const databaseOk = health.status === 'connected' && health.error === null;
  // Only exercise the database-bound helpers once the database itself checks out.
  const helpers = await checkSharedHelpers({ database: databaseOk });
  const encryption = databaseOk ? await checkEncryption() : null;
  const storage = await checkStorage();
  const uploadSettings = databaseOk
    ? await currentFileUploadSettings().catch(() => DEFAULT_FILE_UPLOAD_SETTINGS)
    : DEFAULT_FILE_UPLOAD_SETTINGS;
  const redis = await checkRedis();
  // The job checks need a running worker; without one they would only time out.
  const jobs =
    redis.status === 'connected' && redis.error === null && redis.worker
      ? await runDevJobChecks({ database: databaseOk })
      : null;

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-8 sm:px-8">
      <header className="flex flex-col gap-2">
        <p className="text-footnote text-text-secondary">Development only</p>
        <h1 className="text-display">Health</h1>
        <p className="text-callout text-text-secondary">
          Checks the services Xtreme Pulse depends on. Reload the page to run the checks again.
        </p>
      </header>
      <DatabaseSection health={health} />
      {helpers.groups.map((group, index) => (
        <HelperSection key={group.title} group={group} index={index} />
      ))}
      <EncryptionSection health={encryption} />
      <StorageSection storage={storage} settings={uploadSettings} />
      {databaseOk && storage.writable ? (
        <UploadForm limitsHint={uploadLimitsText(uploadSettings)} />
      ) : null}
      <RedisSection redis={redis} jobs={jobs} />
      {jobs ? <SampleFilesSection jobs={jobs} /> : null}
    </main>
  );
}
