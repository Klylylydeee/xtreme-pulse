import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { connectDb } from '@pulse/db';
import { EMPLOYMENT_STATUS, type EmploymentStatus } from '../../account';
import { COMMAND_ICONS, COMMAND_PROVIDER_KINDS, type CommandResult } from '../../directory';
import { emptyModuleAccess } from '../../module-access';
import { DepartmentModel } from '../departments/model';
import { EmployeeModel } from '../employees/model';
import { PositionModel } from '../positions/model';
import { UserModel } from '../users/model';
import { PEOPLE_PROVIDER_KEY, registerCoreCommandProviders } from './people-provider';
import {
  type CommandBarUser,
  type CommandProviderDefinition,
  normalizeCommandQuery,
  registerCommandProvider,
  searchCommands,
  unregisterCommandProvider,
} from './registry';

// The command bar registry and Core's people provider (docs/modules/core.md#command-bar,
// SECURITY.md#rules, docs/TESTING.md#directory-org-chart-and-command-bar-tests). Made-up data only.

const USER: CommandBarUser = {
  id: new Types.ObjectId().toHexString(),
  email: 'searcher@xtreme-works.com',
  mustChangePassword: false,
  isSystemAdministrator: false,
  isSystemAccount: false,
  employee: null,
  roles: [],
  moduleAccess: emptyModuleAccess(),
};

const registered: string[] = [];

function provider(
  key: string,
  results: (query: string) => readonly CommandResult[] | Promise<readonly CommandResult[]>,
  overrides: Partial<CommandProviderDefinition> = {},
): CommandProviderDefinition {
  const definition: CommandProviderDefinition = {
    key,
    group: 'Test',
    kind: 'records',
    isVisibleTo: () => true,
    search: async (query) => results(query),
    ...overrides,
  };
  registerCommandProvider(definition);
  registered.push(key);
  return definition;
}

function result(id: string, overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    id,
    title: `Result ${id}`,
    subtitle: null,
    href: `/test/${id}`,
    icon: 'action',
    ...overrides,
  };
}

/** The groups from the test providers only (Core's own may be registered too). */
async function testGroups(query: string) {
  return (await searchCommands(USER, query)).filter((group) => group.key.startsWith('test.'));
}

afterEach(() => {
  for (const key of registered.splice(0)) unregisterCommandProvider(key);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('the fixed sets', () => {
  it('are the step 1.11 kinds and icons', () => {
    expect(COMMAND_PROVIDER_KINDS).toEqual(['records', 'actions']);
    expect(COMMAND_ICONS).toEqual(['person', 'action']);
  });
});

describe('the query', () => {
  it('is trimmed, cut to 100 characters, and searched from 2 characters', async () => {
    expect(normalizeCommandQuery('  ab  ')).toBe('ab');
    expect(normalizeCommandQuery('a')).toBeNull();
    expect(normalizeCommandQuery('   ')).toBeNull();
    expect(normalizeCommandQuery(42)).toBeNull();
    expect(normalizeCommandQuery('x'.repeat(150))).toHaveLength(100);

    const search = vi.fn(async () => [result('1')]);
    provider('test.short', () => [], { search });
    expect(await searchCommands(USER, 'a')).toEqual([]);
    expect(await searchCommands(USER, '  b ')).toEqual([]);
    expect(search).not.toHaveBeenCalled();

    await searchCommands(USER, `  ${'y'.repeat(120)}  `);
    expect(search).toHaveBeenCalledWith('y'.repeat(100), USER, { limit: 8 });
  });
});

describe('the registry', () => {
  it('never calls a provider whose isVisibleTo refuses the user', async () => {
    const search = vi.fn(async () => [result('1')]);
    const isVisibleTo = vi.fn(() => false);
    provider('test.hidden', () => [], { search, isVisibleTo });
    provider('test.shown', () => [result('2')]);
    const groups = await testGroups('query');
    expect(groups.map((group) => group.key)).toEqual(['test.shown']);
    expect(isVisibleTo).toHaveBeenCalledWith(USER);
    expect(search).not.toHaveBeenCalled();
  });

  it('returns at most 8 results per provider, in registration order', async () => {
    provider('test.many', () => Array.from({ length: 12 }, (_, i) => result(String(i))));
    provider('test.second', () => [result('a')], { group: 'Second', kind: 'actions' });
    const groups = await testGroups('query');
    expect(groups.map((group) => [group.key, group.group, group.kind])).toEqual([
      ['test.many', 'Test', 'records'],
      ['test.second', 'Second', 'actions'],
    ]);
    expect(groups[0]?.results).toHaveLength(8);
    expect(groups[0]?.results.map((r) => r.id)).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
  });

  it('drops a result whose link isn’t a path inside the app, or whose icon is unknown', async () => {
    provider('test.links', () => [
      result('ok'),
      result('full', { href: 'https://example.com/' }),
      result('protocol', { href: '//example.com' }),
      result('backslash', { href: '/\\example.com' }),
      result('relative', { href: 'test/1' }),
      result('script', { href: 'javascript:alert(1)' }),
      result('icon', { icon: 'rocket' as never }),
      { ...result('extra'), secret: 'never-sent' } as CommandResult,
    ]);
    const [group] = await testGroups('query');
    expect(group?.results.map((r) => r.id)).toEqual(['ok', 'extra']);
    expect(group?.results[1]).toEqual(result('extra'));
  });

  it('leaves out a provider that throws, and logs its key only, never the query', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    provider('test.broken', (query) => {
      throw new Error(`Failed on ${query}`);
    });
    provider('test.hiddenBroken', () => [], {
      isVisibleTo: () => {
        throw new Error('no');
      },
    });
    provider('test.fine', () => [result('1')]);

    const groups = await testGroups('secret-query');
    expect(groups.map((group) => group.key)).toEqual(['test.fine']);
    expect(log).toHaveBeenCalledTimes(2);
    const logged = log.mock.calls.flat().map(String).join('\n');
    expect(logged).toContain('test.broken');
    expect(logged).toContain('test.hiddenBroken');
    expect(logged).not.toContain('secret-query');
  });

  it('runs the providers in parallel', async () => {
    let running = 0;
    let most = 0;
    const slow = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return [result('1')];
    };
    provider('test.slowA', () => [], { search: slow });
    provider('test.slowB', () => [], { search: slow });
    await testGroups('query');
    expect(most).toBe(2);
  });

  it('refuses a bad key or kind, and a second registration of a key in production', () => {
    expect(() => provider('NoDot', () => [])).toThrow(/a command provider key/);
    expect(() => provider('test.kind', () => [], { kind: 'other' as never })).toThrow(/kind/);
    provider('test.once', () => []);
    expect(() => provider('test.once', () => [])).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => provider('test.once', () => [])).toThrow(/already registered/);
  });
});

// --- The people provider -----------------------------------------------------------------------

let counter = 0;
let departmentId: Types.ObjectId;
let positionId: Types.ObjectId;

async function person(
  firstName: string,
  lastName: string,
  {
    status = 'Regular',
    employeeNumber,
  }: { status?: EmploymentStatus; employeeNumber?: string } = {},
) {
  counter += 1;
  const employee = await EmployeeModel.create({
    employeeNumber: employeeNumber ?? `2030-${String(counter).padStart(2, '0')}`,
    firstName,
    lastName,
    departmentId,
    positionId,
    reportingTo: [],
    employmentStatus: status,
    dateHired: new Date('2024-01-01T00:00:00+08:00'),
    separationDate:
      EMPLOYMENT_STATUS[status] === 'active' ? null : new Date('2024-06-01T00:00:00+08:00'),
  });
  await UserModel.create({
    email: `people${counter}@xtreme-works.com`,
    passwordHash: 'made-up-hash',
    employeeId: employee._id,
  });
  return { id: employee._id.toHexString(), employeeNumber: employee.employeeNumber };
}

async function people(query: string) {
  registerCoreCommandProviders();
  const groups = await searchCommands(USER, query);
  return groups.find((group) => group.key === PEOPLE_PROVIDER_KEY);
}

describe('the people provider', () => {
  beforeAll(async () => {
    await connectDb();
    await Promise.all([
      DepartmentModel.init(),
      PositionModel.init(),
      EmployeeModel.init(),
      UserModel.init(),
    ]);
    const department = await DepartmentModel.create({ name: 'Network', code: 'NET' });
    departmentId = department._id;
    const position = await PositionModel.create({
      name: 'Network Engineer',
      departmentId,
      timesheetType: 'standard',
    });
    positionId = position._id;
    await UserModel.create({
      email: 'system@xtreme-works.com',
      passwordHash: 'made-up-hash',
      isSystemAdministrator: true,
      isSystemAccount: true,
      employeeId: null,
    });
  });

  it('is registered once, safely on every call', () => {
    registerCoreCommandProviders();
    expect(() => registerCoreCommandProviders()).not.toThrow();
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => registerCoreCommandProviders()).not.toThrow();
  });

  it('finds a person by name and by employee number, with the name, number and position', async () => {
    const ana = await person('Ana', 'Cruz', { employeeNumber: '2027-01' });
    const expected = {
      id: ana.id,
      title: 'Ana Cruz',
      subtitle: '2027-01 · Network Engineer',
      href: `/directory?person=${ana.id}`,
      icon: 'person',
    };
    expect((await people('ana cruz'))?.results).toEqual([expected]);
    expect((await people('2027-01'))?.results).toEqual([expected]);
    expect((await people('Cru'))?.group).toBe('People');
  });

  it('never returns separated people or the system account', async () => {
    await person('Sep', 'Gone', { status: 'Resigned' });
    expect((await people('Gone'))?.results).toEqual([]);
    expect((await people('system'))?.results).toEqual([]);
    expect((await people('sysadmin'))?.results).toEqual([]);
  });

  it('returns at most 8 people', async () => {
    for (let i = 0; i < 10; i += 1) await person(`P${i}`, 'Many');
    expect((await people('Many'))?.results).toHaveLength(8);
  });
});
