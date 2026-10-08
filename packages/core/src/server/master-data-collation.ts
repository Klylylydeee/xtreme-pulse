// Spec: docs/modules/core.md#managing-master-data (decision 88 in docs/BUILD_PLAN.md) — master
// data names compare ignoring case (`Verifone` and `verifone` are the same name). The unique
// indexes use this collation, and a query that relies on one (a name lookup or a duplicate check)
// must pass the same collation, or it compares case-sensitively and can't use the index.

/** Case-insensitive comparison: English, strength 2 (accents count, case doesn't). */
export const MASTER_DATA_COLLATION = { locale: 'en', strength: 2 } as const;
