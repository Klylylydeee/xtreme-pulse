import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { EMAIL_DOMAIN_PATTERN } from '../../account';

// Spec: SECURITY.md#sign-in-and-passwords — the email domains sign-in and user creation accept.
// Seeded from ALLOWED_EMAIL_DOMAINS; the System Administrator manages them (build step 1.4).

export interface AllowedEmailDomainRecord {
  _id: Types.ObjectId;
  /** Lowercase, without the `@`, for example `xtreme-works.com`. */
  domain: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const allowedEmailDomainSchema = new Schema<AllowedEmailDomainRecord>({
  domain: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    match: [EMAIL_DOMAIN_PATTERN, 'Enter a domain such as xtreme-works.com, without the @.'],
  },
});

allowedEmailDomainSchema.index({ domain: 1 }, { unique: true });

// Removing a domain soft-deletes it, so the seed script won't add it back.
allowedEmailDomainSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const AllowedEmailDomainModel = defineModel(
  'AllowedEmailDomain',
  allowedEmailDomainSchema,
  'allowedEmailDomains',
);
