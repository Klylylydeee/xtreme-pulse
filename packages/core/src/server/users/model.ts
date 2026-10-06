import { Schema, type SchemaDefinition, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { emailDomainOf } from '../../account';
import { MODULE_ACCESS_LEVELS, type ModuleAccess } from '../../module-access';
import { MODULES } from '../../modules';

// Spec: SECURITY.md#account--access and docs/modules/core.md#people-data-ownership — the user
// account. Every user is an employee (`employeeId`), except the bootstrap system account.
//
// There is no stored account status: it is derived from the employee's employment status
// (SECURITY.md#account-status). The bootstrap system account has no employee, so it is active
// unless `systemAccountDisabled` is set (docs/DATA_MODEL.md#derived-values).
//
// Spec: SECURITY.md#resolving-and-enforcing-build-step-16 — the stored module access, one level
// per module (decision 50 in docs/BUILD_PLAN.md). Each defaults to None, and a missing key or a
// missing subdocument reads as None (resolveModuleAccess), so older accounts need no migration.
// Only the access service (access/service.ts, build step 1.7) writes it, and it sets
// `moduleAccessChangedAt` / `moduleAccessChangedBy` on every change (decision 67). A System
// Administrator's stored values are ignored: they resolve to Owner everywhere, and the switch
// never writes them (decision 65).

export interface UserRecord {
  _id: Types.ObjectId;
  /** Lowercase and trimmed. */
  email: string;
  /** The argon2id hash (see auth/password.ts). Never selected by default, never sent anywhere. */
  passwordHash: string;
  /** True while the password is a temporary one; the user must change it first. */
  mustChangePassword: boolean;
  isSystemAdministrator: boolean;
  /** The bootstrap system account (docs/modules/core.md#bootstrap-system-administrator-account). */
  isSystemAccount: boolean;
  /** Set by another System Administrator to disable the system account. Only on that account. */
  systemAccountDisabled: boolean;
  /** The employee this account belongs to; null only for the system account. */
  employeeId: Types.ObjectId | null;
  /**
   * Set by a password reset: a session that signed in before it is refused, so every session the
   * user had ends (SECURITY.md#sign-in-and-passwords). Null until the first reset.
   */
  sessionsValidFrom: Date | null;
  /**
   * The stored level per module. Absent on accounts stored before step 1.6, and a key may be
   * missing: read it through resolveModuleAccess, never directly.
   */
  moduleAccess?: Partial<ModuleAccess>;
  /**
   * When the module access or the System Administrator switch last changed on the User access
   * page ("Last changed", and the stale-form check). Null (or absent on older accounts) until then.
   */
  moduleAccessChangedAt?: Date | null;
  /** Who made that change. Null (or absent) until the first change. */
  moduleAccessChangedBy?: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

// One key per module, each an enum of the levels that module takes, so `owner` or `write` on
// Insight and an unknown level are refused on save.
const moduleAccessSchema = new Schema<ModuleAccess>(
  Object.fromEntries(
    MODULES.map((module) => [
      module,
      { type: String, enum: [...MODULE_ACCESS_LEVELS[module]], required: true, default: 'none' },
    ]),
  ) as SchemaDefinition<ModuleAccess>,
  { _id: false },
);

const userSchema = new Schema<UserRecord>({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    // Shape only. The allowed-domain check runs in services (bootstrap, sign-in, user creation)
    // against the stored allowedEmailDomains records (SECURITY.md#sign-in-and-passwords,
    // docs/modules/core.md#bootstrap-system-administrator-account).
    validate: {
      validator: (value: string) => emailDomainOf(value) !== null,
      message: 'Enter a valid email address.',
    },
  },
  passwordHash: { type: String, required: true, select: false },
  mustChangePassword: { type: Boolean, required: true, default: true },
  isSystemAdministrator: { type: Boolean, required: true, default: false },
  isSystemAccount: { type: Boolean, required: true, default: false, immutable: true },
  systemAccountDisabled: { type: Boolean, required: true, default: false },
  employeeId: { type: Schema.Types.ObjectId, default: null },
  sessionsValidFrom: { type: Date, default: null },
  // A new account starts with None on every module (SECURITY.md#rules).
  moduleAccess: { type: moduleAccessSchema, default: () => ({}) },
  moduleAccessChangedAt: { type: Date, default: null },
  moduleAccessChangedBy: { type: Schema.Types.ObjectId, default: null },
});

userSchema.index({ email: 1 }, { unique: true });
// One account per employee. The system account has no employee.
userSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { employeeId: { $type: 'objectId' } } },
);
userSchema.index({ isSystemAdministrator: 1 });
// The User access page's "Needs access" group, newest first.
userSchema.index({ createdAt: -1 });
// There is exactly one bootstrap system account, even when two seed runs race.
userSchema.index(
  { isSystemAccount: 1 },
  { unique: true, partialFilterExpression: { isSystemAccount: true } },
);

userSchema.pre('validate', function () {
  if (this.isSystemAccount) {
    if (this.employeeId !== null)
      this.invalidate('employeeId', 'The system account has no employee.');
  } else {
    if (this.employeeId === null)
      this.invalidate('employeeId', 'Choose the employee this account belongs to.');
    if (this.systemAccountDisabled) {
      this.invalidate('systemAccountDisabled', 'Only the system account can be disabled this way.');
    }
  }
});

// The hash never leaves the server, even when a document is serialized by mistake.
userSchema.set('toJSON', {
  transform: (_doc, ret: Partial<UserRecord>) => {
    delete ret.passwordHash;
    return ret;
  },
});

// Users are deactivated through employment status, never deleted (SECURITY.md#account-status).
userSchema.plugin(baseSchemaPlugin, { softDelete: false });

export const UserModel = defineModel('User', userSchema, 'users');
