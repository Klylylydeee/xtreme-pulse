import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import {
  CONTACT_EMAIL_MAX_LENGTH,
  CONTACT_MOBILE_MAX_LENGTH,
  CONTACT_POSITION_MAX_LENGTH,
  PERSON_NAME_MAX_LENGTH,
} from '../../master-data';

// Spec: docs/modules/engage.md#clients-sites-and-contacts — a client's contacts. Removing a
// contact soft-deletes it, and it can be restored (docs/modules/core.md#managing-master-data).

export interface ClientContactRecord {
  _id: Types.ObjectId;
  clientId: Types.ObjectId;
  name: string;
  position: string | null;
  /** Lowercased. */
  email: string | null;
  /** Stored as typed (checked leniently as a Philippine mobile). */
  mobile: string | null;
  /** At most one per client. Cleared when the contact is removed. */
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const clientContactSchema = new Schema<ClientContactRecord>({
  // A contact belongs to its client for good.
  clientId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  name: { type: String, required: true, trim: true, maxlength: PERSON_NAME_MAX_LENGTH },
  position: { type: String, default: null, trim: true, maxlength: CONTACT_POSITION_MAX_LENGTH },
  email: {
    type: String,
    default: null,
    trim: true,
    lowercase: true,
    maxlength: CONTACT_EMAIL_MAX_LENGTH,
  },
  mobile: { type: String, default: null, trim: true, maxlength: CONTACT_MOBILE_MAX_LENGTH },
  isPrimary: { type: Boolean, required: true, default: false },
});

/** The partial unique index that allows one primary contact per client. */
export const PRIMARY_CONTACT_INDEX = 'clientId_1_primary';

clientContactSchema.index({ clientId: 1 });
// Only primary contacts are in this index, so a client holds at most one. Soft-deleted contacts
// are in it too, which is why removing a contact clears its flag: a removed contact never holds
// the slot, and a restored one comes back not primary.
clientContactSchema.index(
  { clientId: 1 },
  { unique: true, name: PRIMARY_CONTACT_INDEX, partialFilterExpression: { isPrimary: true } },
);

// Removing a contact soft-deletes it.
clientContactSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const ClientContactModel = defineModel(
  'ClientContact',
  clientContactSchema,
  'clientContacts',
);
