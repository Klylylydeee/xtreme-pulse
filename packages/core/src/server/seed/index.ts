// The seed script's building blocks (`pnpm seed:admin`), server-only. Import them from
// `@pulse/core/server/seed`. Later phases add their loaders to the list the script runs.

export {
  createBootstrapAdministrator,
  type CreateBootstrapAdministratorInput,
  type CreateBootstrapAdministratorResult,
  hasSystemAdministrator,
  SeedInputError,
} from './bootstrap-admin';
export { coreSeedLoaders, type SeedLoader, type SeedLoaderResult } from './loaders';
export { recoverSystemAdministrator, type RecoverSystemAdministratorResult } from './recover-admin';
