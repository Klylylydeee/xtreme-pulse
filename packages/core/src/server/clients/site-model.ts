import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { ADDRESS_MAX_LENGTH, CITY_MAX_LENGTH, MASTER_NAME_MAX_LENGTH } from '../../master-data';
import { MASTER_DATA_COLLATION } from '../master-data-collation';

// Spec: docs/modules/engage.md#clients-sites-and-contacts — a client's sites (bank branches,
// stores). Removing a site soft-deletes it, and it can be restored
// (docs/modules/core.md#managing-master-data).

export interface ClientSiteRecord {
  _id: Types.ObjectId;
  clientId: Types.ObjectId;
  /** Unique within the client ignoring case, removed sites included. */
  name: string;
  address: string | null;
  city: string | null;
  /** Free text; not linked to the client's contacts. */
  siteContact: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const clientSiteSchema = new Schema<ClientSiteRecord>({
  // A site belongs to its client for good.
  clientId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  name: { type: String, required: true, trim: true, maxlength: MASTER_NAME_MAX_LENGTH },
  address: { type: String, default: null, trim: true, maxlength: ADDRESS_MAX_LENGTH },
  city: { type: String, default: null, trim: true, maxlength: CITY_MAX_LENGTH },
  siteContact: { type: String, default: null, trim: true, maxlength: MASTER_NAME_MAX_LENGTH },
});

/** The unique, case-insensitive `{ clientId, name }` index. */
export const CLIENT_SITE_NAME_INDEX = 'clientId_1_name_1_ci';

// Removed sites are included, so a removed site's name isn't reused within its client.
clientSiteSchema.index(
  { clientId: 1, name: 1 },
  { unique: true, name: CLIENT_SITE_NAME_INDEX, collation: MASTER_DATA_COLLATION },
);
// A client's sites, for queries without the collation.
clientSiteSchema.index({ clientId: 1 });

// Removing a site soft-deletes it.
clientSiteSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const ClientSiteModel = defineModel('ClientSite', clientSiteSchema, 'clientSites');
