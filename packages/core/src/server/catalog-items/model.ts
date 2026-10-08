import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import {
  DEFAULT_WARRANTY_MONTHS,
  ITEM_DESCRIPTION_MAX_LENGTH,
  ITEM_KINDS,
  type ItemKind,
  PART_NUMBER_MAX_LENGTH,
  UNIT_MAX_LENGTH,
  WARRANTY_MONTHS_MAX,
} from '../../master-data';
import { MASTER_DATA_COLLATION } from '../master-data-collation';

// Spec: docs/modules/supply.md#stock — catalog items: the part numbers used in BOQ lines, stock
// and serials, each under a product, with an item kind and default warranty months
// (docs/modules/desk.md#warranties-support-contracts-and-subscriptions).

export interface CatalogItemRecord {
  _id: Types.ObjectId;
  /** The product. Fixed once created. */
  brandId: Types.ObjectId;
  /** Unique within the product ignoring case, retired items included. */
  partNumber: string;
  description: string;
  /** Free text, with suggestions (`UNIT_SUGGESTIONS`). */
  unit: string;
  /** Fixed once created. */
  itemKind: ItemKind;
  /** A whole number from 0 to 120. */
  defaultWarrantyMonths: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const catalogItemSchema = new Schema<CatalogItemRecord>({
  // The product and the item kind are fixed: to change either, add a new item.
  brandId: { type: Schema.Types.ObjectId, required: true, immutable: true },
  partNumber: { type: String, required: true, trim: true, maxlength: PART_NUMBER_MAX_LENGTH },
  description: {
    type: String,
    required: true,
    trim: true,
    maxlength: ITEM_DESCRIPTION_MAX_LENGTH,
  },
  unit: { type: String, required: true, trim: true, maxlength: UNIT_MAX_LENGTH },
  itemKind: { type: String, required: true, enum: ITEM_KINDS, immutable: true },
  defaultWarrantyMonths: {
    type: Number,
    required: true,
    default: DEFAULT_WARRANTY_MONTHS,
    min: 0,
    max: WARRANTY_MONTHS_MAX,
    validate: {
      validator: (value: number) => Number.isInteger(value),
      message: 'Default warranty is a whole number of months.',
    },
  },
});

/** The unique, case-insensitive `{ brandId, partNumber }` index. */
export const CATALOG_ITEM_PART_NUMBER_INDEX = 'brandId_1_partNumber_1_ci';

// Retired items are included, so a retired item's part number isn't reused within its product.
// Its `brandId` prefix (an ObjectId, which the collation doesn't affect) also serves the count of a
// product's live items that blocks retiring it.
catalogItemSchema.index(
  { brandId: 1, partNumber: 1 },
  { unique: true, name: CATALOG_ITEM_PART_NUMBER_INDEX, collation: MASTER_DATA_COLLATION },
);

// Retiring a catalog item soft-deletes it.
catalogItemSchema.plugin(baseSchemaPlugin, { softDelete: true });

export const CatalogItemModel = defineModel('CatalogItem', catalogItemSchema, 'catalogItems');
