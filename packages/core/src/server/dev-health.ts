import { z } from 'zod';
import { isDatabaseConfigured, redactConnectionString, withTransaction } from '@pulse/db';
import { businessToday, formatDateTime, now, startOfBusinessDate, toBusinessDate } from '../dates';
import { allocateCentavos, formatPeso, ratio, scaleCentavos } from '../money';
import {
  addConfigVersion,
  ConfigVersionExistsError,
  defineConfigSetting,
  findConfigVersion,
} from './config';
import { nextDocumentNumber } from './document-numbers';

// Checks for the development `/dev/health` page (build step 0.6): document numbers, versioned
// configuration, half-up rounding and Manila time. Development data only: the `DEV` prefix and
// the `dev.sampleRate` setting are not business records.

export interface HelperCheck {
  label: string;
  value: string;
  /** true passes, false fails, null is information only. */
  ok: boolean | null;
}

export interface HelperGroup {
  title: string;
  checks: HelperCheck[];
  /** Set when the group couldn't run; its checks are then incomplete. */
  error: string | null;
}

export interface SharedHelpersHealth {
  groups: HelperGroup[];
}

const DEV_PREFIX = 'DEV';
const DEV_RATE = defineConfigSetting('dev.sampleRate', z.string());
const DEV_RATE_VERSIONS = [
  { effectiveFrom: '2026-01-01', value: '0.10' },
  { effectiveFrom: '2026-07-01', value: '0.12' },
] as const;

class RollbackProbe extends Error {}

function describe(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error';
  return redactConnectionString(message);
}

async function runGroup(
  title: string,
  run: (checks: HelperCheck[]) => Promise<void> | void,
): Promise<HelperGroup> {
  const checks: HelperCheck[] = [];
  try {
    await run(checks);
    return { title, checks, error: null };
  } catch (error) {
    return { title, checks, error: describe(error) };
  }
}

async function documentNumberChecks(checks: HelperCheck[]): Promise<void> {
  const first = await withTransaction((session) => nextDocumentNumber(DEV_PREFIX, { session }));
  checks.push({ label: 'First number', value: first.number, ok: true });

  let discarded = '';
  try {
    await withTransaction(async (session) => {
      discarded = (await nextDocumentNumber(DEV_PREFIX, { session })).number;
      throw new RollbackProbe('Abort on purpose');
    });
  } catch (error) {
    if (!(error instanceof RollbackProbe)) throw error;
  }
  checks.push({ label: 'Aborted save', value: `${discarded} rolled back`, ok: null });

  const second = await withTransaction((session) => nextDocumentNumber(DEV_PREFIX, { session }));
  // Another reload of this page at the same moment could take a number in between.
  checks.push({
    label: 'Second number',
    value: second.number,
    ok: second.year === first.year && second.sequence === first.sequence + 1,
  });
}

async function configChecks(checks: HelperCheck[]): Promise<void> {
  for (const version of DEV_RATE_VERSIONS) {
    try {
      await addConfigVersion(DEV_RATE, { ...version, actorId: null, source: 'Development sample' });
    } catch (error) {
      if (!(error instanceof ConfigVersionExistsError)) throw error;
    }
  }
  const cases = [
    { on: '2025-12-31', expected: null },
    { on: '2026-06-30', expected: '0.10' },
    { on: '2026-07-01', expected: '0.12' },
  ] as const;
  for (const { on, expected } of cases) {
    const version = await findConfigVersion(DEV_RATE, on);
    checks.push({
      label: `Sample rate on ${on}`,
      value: version ? `${version.value} (from ${version.effectiveFrom})` : 'None in effect',
      ok: (version?.value ?? null) === expected,
    });
  }
}

function roundingChecks(checks: HelperCheck[]): void {
  const cases: { label: string; actual: number; expected: number }[] = [
    { label: '₱10.05 × 50% (tie)', actual: scaleCentavos(1005, '0.5'), expected: 503 },
    { label: '₱10.04 × 50%', actual: scaleCentavos(1004, '0.5'), expected: 502 },
    { label: '-₱10.05 × 50% (tie)', actual: scaleCentavos(-1005, '0.5'), expected: -503 },
    { label: '12% of ₱1,000.00', actual: scaleCentavos(100_000, '0.12'), expected: 12_000 },
    {
      // ₱30,000 × 12 ÷ 261 ÷ 8 × 1.25 × 2 = ₱431.0344…, rounded once at the end.
      label: '2 h overtime on ₱30,000/month',
      actual: scaleCentavos(3_000_000, ratio(12, 261), ratio(1, 8), '1.25', '2'),
      expected: 43_103,
    },
  ];
  for (const { label, actual, expected } of cases) {
    checks.push({ label, value: formatPeso(actual), ok: actual === expected });
  }

  const split = allocateCentavos(100_000, [1, 1, 1]);
  checks.push({
    label: '₱1,000.00 in 3 lines',
    value: split.map((line) => formatPeso(line)).join(' + '),
    ok: split.join() === '33333,33333,33334',
  });
}

function manilaTimeChecks(checks: HelperCheck[]): void {
  const current = now();
  checks.push({ label: 'Now (UTC)', value: current.toISOString(), ok: null });
  checks.push({ label: 'Now in Manila', value: formatDateTime(current), ok: null });
  checks.push({ label: 'Today in Manila', value: businessToday(), ok: null });

  const beforeMidnight = new Date('2026-09-25T15:59:59Z');
  const midnight = new Date('2026-09-25T16:00:00Z');
  checks.push({
    label: '15:59:59 UTC, Sep 25',
    value: `${toBusinessDate(beforeMidnight)} · ${formatDateTime(beforeMidnight)}`,
    ok: toBusinessDate(beforeMidnight) === '2026-09-25',
  });
  checks.push({
    label: '16:00:00 UTC, Sep 25',
    value: `${toBusinessDate(midnight)} · ${formatDateTime(midnight)}`,
    ok: toBusinessDate(midnight) === '2026-09-26',
  });
  checks.push({
    label: 'Sep 26 starts at (UTC)',
    value: startOfBusinessDate('2026-09-26').toISOString(),
    ok: startOfBusinessDate('2026-09-26').getTime() === midnight.getTime(),
  });
}

/**
 * Runs the shared-helper checks for `/dev/health`. Never throws; failures come back per group.
 * Pass `database: false` to skip the database-bound checks (when the database check failed).
 */
export async function checkSharedHelpers({
  database = true,
}: { database?: boolean } = {}): Promise<SharedHelpersHealth> {
  const groups: HelperGroup[] = [];
  if (database && isDatabaseConfigured()) {
    groups.push(await runGroup('Document numbers', documentNumberChecks));
    groups.push(await runGroup('Versioned configuration', configChecks));
  }
  groups.push(await runGroup('Half-up rounding', roundingChecks));
  groups.push(await runGroup('Manila time', manilaTimeChecks));
  return { groups };
}
