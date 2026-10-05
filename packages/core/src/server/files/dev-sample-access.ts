import { registerFileAccess } from './access';

// The `/dev/health` test upload (build step 0.7) is owned by the `dev.sample` placeholder record
// type. Its files open in development only, for any signed-in user (the route has checked that);
// in production they're refused like an unregistered owner type (SECURITY.md#development-only-pages).
// The check reads NODE_ENV on each call rather than registering conditionally, so the production
// refusal is tested.

/** The owner type of development sample files. Not a business record. */
export const DEV_SAMPLE_FILE_OWNER_TYPE = 'dev.sample';

/** Registers the `dev.sample` file access check. Called by `registerCoreFileAccess`. */
export function registerDevSampleFileAccess(): void {
  registerFileAccess(DEV_SAMPLE_FILE_OWNER_TYPE, () => process.env.NODE_ENV !== 'production');
}
