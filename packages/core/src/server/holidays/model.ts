import { Schema, type Types } from 'mongoose';
import { baseSchemaPlugin, defineModel } from '@pulse/db';
import {
  HOLIDAY_LEGAL_BASIS_MAX_LENGTH,
  HOLIDAY_LOCATION_MAX_LENGTH,
  HOLIDAY_NAME_MAX_LENGTH,
  HOLIDAY_SCOPES,
  HOLIDAY_SOURCES,
  HOLIDAY_STATUSES,
  HOLIDAY_TYPES,
  HOLIDAY_YEAR_MAX,
  HOLIDAY_YEAR_MIN,
  type HolidayScope,
  type HolidaySource,
  type HolidayStatus,
  type HolidayType,
} from '../../holidays';

// Spec: docs/modules/core.md#holiday-calendar and docs/DATA_MODEL.md#collection-ownership (build
// step 1.10, decision 111 in docs/BUILD_PLAN.md) — one record per holiday, with the base fields and
// soft delete. Private to the holiday services (./service.ts, ./auto-draft.ts): other modules read
// confirmed holidays through `listConfirmedHolidays()` and never use this model.
//
// - `date` is the Manila day at 00:00, stored as UTC (`startOfBusinessDate`), like
//   `employees.separationDate`. It can move only within its year (the service checks).
// - `year` is derived from `date` at create and fixed from then on, so `{ year, sourceKey }` stays
//   valid when a holiday is moved.
// - `source` and `sourceKey` are fixed once created. A moved or deleted auto-draft keeps its
//   `sourceKey`, so the partial unique index (deleted records included) stops it being drafted
//   again.

export interface HolidayRecord {
  _id: Types.ObjectId;
  name: string;
  date: Date;
  year: number;
  type: HolidayType;
  scope: HolidayScope;
  /** Free text, required when the scope is local; null for a nationwide holiday. */
  location: string | null;
  /** For example "Proclamation No. 1006". Optional on a draft, required to confirm. */
  legalBasis: string | null;
  status: HolidayStatus;
  source: HolidaySource;
  /** Null for a manual holiday, `rule:<key>` or `online:<YYYY-MM-DD>`. */
  sourceKey: string | null;
  /** True for an ad-hoc declaration (source `manual`, confirmed at once). */
  declared: boolean;
  confirmedAt: Date | null;
  confirmedBy: Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Types.ObjectId | null;
  updatedBy: Types.ObjectId | null;
  deletedAt: Date | null;
}

const holidaySchema = new Schema<HolidayRecord>({
  name: { type: String, required: true, trim: true, maxlength: HOLIDAY_NAME_MAX_LENGTH },
  date: { type: Date, required: true },
  year: {
    type: Number,
    required: true,
    immutable: true,
    min: HOLIDAY_YEAR_MIN,
    max: HOLIDAY_YEAR_MAX,
    validate: { validator: Number.isInteger, message: 'The year must be a whole number.' },
  },
  type: { type: String, required: true, enum: HOLIDAY_TYPES },
  scope: { type: String, required: true, enum: HOLIDAY_SCOPES },
  location: { type: String, default: null, trim: true, maxlength: HOLIDAY_LOCATION_MAX_LENGTH },
  legalBasis: {
    type: String,
    default: null,
    trim: true,
    maxlength: HOLIDAY_LEGAL_BASIS_MAX_LENGTH,
  },
  status: { type: String, required: true, enum: HOLIDAY_STATUSES, default: 'draft' },
  source: { type: String, required: true, enum: HOLIDAY_SOURCES, immutable: true },
  sourceKey: { type: String, default: null, immutable: true },
  declared: { type: Boolean, required: true, default: false },
  confirmedAt: { type: Date, default: null },
  confirmedBy: { type: Schema.Types.ObjectId, default: null },
});

holidaySchema.index({ year: 1, date: 1 });
holidaySchema.index({ status: 1, date: 1 });
// Deleted records included (a unique index ignores soft delete), so an auto-draft or an online
// draft is never made twice, even after HR deletes or moves it.
holidaySchema.index(
  { year: 1, sourceKey: 1 },
  { unique: true, partialFilterExpression: { sourceKey: { $type: 'string' } } },
);

// Deleting a holiday soft-deletes it (no restore screen in step 1.10).
holidaySchema.plugin(baseSchemaPlugin, { softDelete: true });

export const HolidayModel = defineModel('Holiday', holidaySchema, 'holidays');
