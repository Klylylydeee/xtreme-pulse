import {
  COMMAND_PROVIDER_KINDS,
  COMMAND_PROVIDER_RESULT_LIMIT,
  COMMAND_QUERY_MAX_LENGTH,
  COMMAND_QUERY_MIN_LENGTH,
  type CommandProviderKind,
  type CommandResult,
  type CommandResultGroup,
  isCommandIcon,
} from '../../directory';
import { isInternalHref } from '../../notifications';
import type { CurrentUser } from '../auth/session-user';

// Spec: docs/modules/core.md#command-bar, SECURITY.md#rules ("Command bar providers") and
// docs/ARCHITECTURE.md#cross-module-integration (decisions 143–145 in docs/BUILD_PLAN.md) — every
// module adds its records and actions to the command bar through `registerCommandProvider`.
//
// - Only the providers whose `isVisibleTo(user)` accepts the user are called, and each provider
//   still checks its own records, so a result never names something the user can't open.
// - Queries are trimmed and cut to 100 characters; under 2 characters nothing is searched. Each
//   provider returns at most 8 results. Every result's link must be a path inside the app (the
//   notification link rule); any other result is dropped.
// - A provider that fails is left out of the answer, and the log names its key only, never the
//   query, the user or a record. Nothing is cached, and searches aren't audit-logged.
// - Results are links only: nothing in the command bar changes data.
//
// Registrations are per process and explicit, like the approval types (approvals/registry.ts):
// `registerCoreCommandProviders()` registers Core's own, and each module's
// `register<Module>CommandProviders()` is called beside it by whatever searches.

/** Who is searching: the signed-in user. */
export type CommandBarUser = CurrentUser;

/** What a provider's `search` is given besides the query. */
export interface CommandSearchContext {
  /** The most results to return; more are cut. */
  limit: number;
}

export interface CommandProviderDefinition {
  /** `<module>.<name>`, for example `core.people`. Unique. */
  key: string;
  /** The group heading the command bar shows, for example "People". */
  group: string;
  kind: CommandProviderKind;
  /** Whether the user may see this provider's results at all (module access, a role). */
  isVisibleTo: (user: CommandBarUser) => boolean | Promise<boolean>;
  /**
   * The results for `query` (trimmed, 2 to 100 characters). Checks the user's access to each
   * record itself, and returns at most `limit`.
   */
  search: (
    query: string,
    user: CommandBarUser,
    context: CommandSearchContext,
  ) => Promise<readonly CommandResult[]>;
}

const KEY_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/;

// Per process (and per bundle, since Next evaluates server modules once per bundle). In
// registration order, which is the order of the command bar's groups.
const registry = new Map<string, Readonly<CommandProviderDefinition>>();

/**
 * Registers a command bar provider. Registering the same key again replaces it outside
 * production, where a hot reload evaluates the registering code again; in production it throws,
 * so nothing can quietly swap a provider that is already registered.
 */
export function registerCommandProvider(definition: CommandProviderDefinition): void {
  const { key, group, kind } = definition;
  if (!KEY_PATTERN.test(key)) {
    throw new Error(
      `"${key}" isn't a command provider key. Use <module>.<name>, like core.people.`,
    );
  }
  if (!group.trim()) throw new Error(`The command provider "${key}" needs a group.`);
  if (!(COMMAND_PROVIDER_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`The command provider "${key}" has an unknown kind.`);
  }
  if (typeof definition.isVisibleTo !== 'function' || typeof definition.search !== 'function') {
    throw new Error(`The command provider "${key}" needs isVisibleTo and search.`);
  }
  if (registry.has(key) && process.env.NODE_ENV === 'production') {
    throw new Error(`The command provider "${key}" is already registered.`);
  }
  registry.set(key, Object.freeze({ ...definition }));
}

/** True when a provider is registered under `key`. */
export function hasCommandProvider(key: string): boolean {
  return registry.has(key);
}

/** Removes a registration. For tests only. */
export function unregisterCommandProvider(key: string): void {
  registry.delete(key);
}

/** The query as the providers get it: trimmed and cut to 100 characters; null when too short. */
export function normalizeCommandQuery(query: unknown): string | null {
  if (typeof query !== 'string') return null;
  const trimmed = query.trim().slice(0, COMMAND_QUERY_MAX_LENGTH).trim();
  return Array.from(trimmed).length >= COMMAND_QUERY_MIN_LENGTH ? trimmed : null;
}

/** A result rebuilt with only its known fields, or null when it breaks a rule. */
function cleanResult(result: unknown): CommandResult | null {
  if (typeof result !== 'object' || result === null) return null;
  const { id, title, subtitle, href, icon } = result as Record<string, unknown>;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof title !== 'string' || title.trim().length === 0) return null;
  if (subtitle !== undefined && subtitle !== null && typeof subtitle !== 'string') return null;
  if (!isInternalHref(href)) return null;
  if (!isCommandIcon(icon)) return null;
  return { id, title, subtitle: subtitle ?? null, href, icon };
}

/** Logs a provider's failure by its key only: never the query, the user or the error's text. */
function logFailure(key: string): void {
  console.error(`Command bar provider ${key} failed; its results were left out.`);
}

async function runProvider(
  provider: Readonly<CommandProviderDefinition>,
  query: string,
  user: CommandBarUser,
): Promise<CommandResultGroup | null> {
  try {
    if (!(await provider.isVisibleTo(user))) return null;
    const found = await provider.search(query, user, { limit: COMMAND_PROVIDER_RESULT_LIMIT });
    if (!Array.isArray(found)) throw new Error('Not a list.');
    const results: CommandResult[] = [];
    const ids = new Set<string>();
    for (const item of found) {
      const result = cleanResult(item);
      if (!result || ids.has(result.id)) continue;
      ids.add(result.id);
      results.push(result);
      if (results.length >= COMMAND_PROVIDER_RESULT_LIMIT) break;
    }
    return { key: provider.key, group: provider.group, kind: provider.kind, results };
  } catch {
    logFailure(provider.key);
    return null;
  }
}

/**
 * Searches every provider the user may see, in parallel, and returns one group per provider that
 * answered, in registration order (an empty group included, so the command bar can tell a
 * provider with no match from one that failed: a failed provider is left out). A query under 2
 * characters returns no groups and calls no provider.
 */
export async function searchCommands(
  user: CommandBarUser,
  query: string,
): Promise<CommandResultGroup[]> {
  const normalized = normalizeCommandQuery(query);
  if (normalized === null) return [];
  const providers = [...registry.values()];
  const groups = await Promise.all(
    providers.map((provider) => runProvider(provider, normalized, user)),
  );
  return groups.filter((group): group is CommandResultGroup => group !== null);
}
