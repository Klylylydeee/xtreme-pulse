import { registerCompanySettingsFileAccess } from '../company-settings/file-access';
import { registerDevSampleFileAccess } from './dev-sample-access';

// Core's file access registrations (docs/ARCHITECTURE.md#file-storage). They're registered by an
// explicit call, not as a side effect of importing a module, so it's plain where they happen: the
// file route calls `registerCoreFileAccess()` before it checks a file. Until it runs, every owner
// type is unregistered and refused (fail closed). Another module's registrations get their own
// `register<Module>FileAccess()`, called beside this one; the build step that adds the first one
// adds that call.

let registered = false;

/**
 * Registers Core's file access checks: the company logo (`core.companySettings`) and the
 * development sample (`dev.sample`). Safe to call on every request: it registers once per process
 * (per bundle in Next), and later calls do nothing.
 */
export function registerCoreFileAccess(): void {
  if (registered) return;
  registerCompanySettingsFileAccess();
  registerDevSampleFileAccess();
  registered = true;
}
