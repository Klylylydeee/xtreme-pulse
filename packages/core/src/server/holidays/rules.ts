import { type HolidayRules, holidayRulesSchema } from '../../holidays';
import { defineConfigSetting } from '../config';

// Spec: docs/modules/core.md#holiday-calendar and docs/DATA_MODEL.md#versioned-configuration
// (decisions 112, 113 and 129 in docs/BUILD_PLAN.md) — the auto-draft rules are versioned
// configuration, not code, because holidays are added or changed by law. `pnpm seed:admin` adds
// the first version once, only when the setting has none, effective from the day it is seeded
// (seed/loaders.ts). A run uses the version in effect on the Manila day it runs. Step 1.10 has no
// editor: a new version is added through the configuration store (`addConfigVersion`).

/** The setting `core.holidayRules`: a list of rules (see `holidayRuleSchema` in `@pulse/core`). */
export const HOLIDAY_RULES_SETTING = defineConfigSetting('core.holidayRules', holidayRulesSchema);

/** The source noted on the seeded version. */
export const SEED_HOLIDAY_RULES_SOURCE =
  'Seeded defaults: regular holidays per RA 9492 as amended. Check each year against the Presidential Proclamation.';

// The seeded rules (docs/modules/core.md#holiday-calendar, "Seeded rules"). Regular holidays
// follow RA 9492 as amended; the rest default to special non-working days, apart from the EDSA
// anniversary, a special working day. Types and dates change by proclamation, so HR checks every
// auto-draft before confirming it. Weekdays: 0 Sunday … 6 Saturday.
export const SEED_HOLIDAY_RULES: HolidayRules = [
  { key: 'newYearsDay', name: "New Year's Day", type: 'regular', kind: 'fixed', month: 1, day: 1 },
  {
    key: 'edsaRevolutionAnniversary',
    name: 'EDSA People Power Revolution Anniversary',
    type: 'specialWorking',
    kind: 'fixed',
    month: 2,
    day: 25,
  },
  {
    key: 'maundyThursday',
    name: 'Maundy Thursday',
    type: 'regular',
    kind: 'easterOffset',
    offsetDays: -3,
  },
  { key: 'goodFriday', name: 'Good Friday', type: 'regular', kind: 'easterOffset', offsetDays: -2 },
  {
    key: 'blackSaturday',
    name: 'Black Saturday',
    type: 'specialNonWorking',
    kind: 'easterOffset',
    offsetDays: -1,
  },
  {
    key: 'arawNgKagitingan',
    name: 'Araw ng Kagitingan',
    type: 'regular',
    kind: 'fixed',
    month: 4,
    day: 9,
  },
  { key: 'laborDay', name: 'Labor Day', type: 'regular', kind: 'fixed', month: 5, day: 1 },
  {
    key: 'independenceDay',
    name: 'Independence Day',
    type: 'regular',
    kind: 'fixed',
    month: 6,
    day: 12,
  },
  {
    key: 'ninoyAquinoDay',
    name: 'Ninoy Aquino Day',
    type: 'specialNonWorking',
    kind: 'fixed',
    month: 8,
    day: 21,
  },
  {
    key: 'nationalHeroesDay',
    name: 'National Heroes Day',
    type: 'regular',
    kind: 'lastWeekday',
    month: 8,
    weekday: 1,
  },
  {
    key: 'allSaintsDay',
    name: "All Saints' Day",
    type: 'specialNonWorking',
    kind: 'fixed',
    month: 11,
    day: 1,
  },
  {
    key: 'allSoulsDay',
    name: "All Souls' Day",
    type: 'specialNonWorking',
    kind: 'fixed',
    month: 11,
    day: 2,
  },
  {
    key: 'bonifacioDay',
    name: 'Bonifacio Day',
    type: 'regular',
    kind: 'fixed',
    month: 11,
    day: 30,
  },
  {
    key: 'immaculateConception',
    name: 'Feast of the Immaculate Conception',
    type: 'specialNonWorking',
    kind: 'fixed',
    month: 12,
    day: 8,
  },
  {
    key: 'christmasEve',
    name: 'Christmas Eve',
    type: 'specialNonWorking',
    kind: 'fixed',
    month: 12,
    day: 24,
  },
  {
    key: 'christmasDay',
    name: 'Christmas Day',
    type: 'regular',
    kind: 'fixed',
    month: 12,
    day: 25,
  },
  { key: 'rizalDay', name: 'Rizal Day', type: 'regular', kind: 'fixed', month: 12, day: 30 },
  {
    key: 'lastDayOfTheYear',
    name: 'Last Day of the Year',
    type: 'specialNonWorking',
    kind: 'fixed',
    month: 12,
    day: 31,
  },
];
