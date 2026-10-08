import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import { PRODUCT_NAME_MAX_LENGTH } from '../../master-data';
import { MASTER_DATA_COLLATION } from '../master-data-collation';

// Spec: docs/modules/engage.md#deals-and-stages — products (`brands` in code) are Pulse Core
// master data, records rather than an enum (docs/modules/core.md#managing-master-data). Catalog
// items belong to a product.

export interface BrandRecord {
  _id: Types.ObjectId;
  /** Unique ignoring case, retired products included. Renaming is allowed, seeded ones included. */
  name: string;
  /**
   * Set on products the seed script created (`extremeNetworks`), so a later run finds them even
   * after a rename. Null for products added on the screens.
   */
  seedKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const brandSchema = new Schema<BrandRecord>({
  name: { type: String, required: true, trim: true, maxlength: PRODUCT_NAME_MAX_LENGTH },
  seedKey: { type: String, default: null, immutable: true },
});

/** The unique, case-insensitive `{ name }` index. */
export const BRAND_NAME_INDEX = 'name_1_ci';

// Retired products are included, so a retired product's name isn't reused.
brandSchema.index(
  { name: 1 },
  { unique: true, name: BRAND_NAME_INDEX, collation: MASTER_DATA_COLLATION },
);
brandSchema.index(
  { seedKey: 1 },
  { unique: true, partialFilterExpression: { seedKey: { $type: 'string' } } },
);

// Retiring a product soft-deletes it.
brandSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const BrandModel = defineModel('Brand', brandSchema, 'brands');
