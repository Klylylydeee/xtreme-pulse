// Step 2.9's pure pay engine (docs/modules/talent.md#payroll-run-computation-build-step-29;
// decisions 325–349 in docs/BUILD_PLAN.md): the run's fixed sets and words, the run policy
// type, one cut-off's own pay, the run line with settlements, contributions and tax, the
// breakdown's JSON shape, and the cut-off and calendar helpers. Plain data in, plain data out:
// no database, safe in the browser.

export * from './kinds';
export * from './types';
export {
  attendanceItemOf,
  computePeriodPay,
  isAttendanceItem,
  isEmployedOn,
  salaryOn,
  workingBaseDays,
} from './period';
export * from './line';
export * from './periods';
export * from './breakdown';
