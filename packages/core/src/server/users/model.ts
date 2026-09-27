import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { emailDomainOf } from '../../account';

// Spec: SECURITY.md#account--access and docs/modules/core.md#people-data-ownership — the user
// account. Every user is an employee (`employeeId`), except the bootstrap system account.
//
// There is no stored account status: it is derived from the employee's employment status
// (SECURITY.md#account-status). The bootstrap system account has no employee, so it is active
// unless `systemAccountDisabled` is set (docs/DATA_MODEL.md#derived-values).
// Module access is added in build step 1.6.

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
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
}

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
});

userSchema.index({ email: 1 }, { unique: true });
// One account per employee. The system account has no employee.
userSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { employeeId: { $type: 'objectId' } } },
);
userSchema.index({ isSystemAdministrator: 1 });
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
