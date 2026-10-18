// Step 2.7's pure Daily Time Record code
// (docs/modules/talent.md#timesheet-approval-the-dtr-and-the-offset-balance-build-step-27), with
// step 2.8's approved time off (decision 315): the day statuses and their labels, the time off
// badges, and `computeDtr` with its input and output types. Derived when read, never stored; safe
// in the browser.

export * from './statuses';
export * from './compute';
