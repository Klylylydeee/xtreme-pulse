# Owner review list

Last updated: 2026-10-19, through step 2.9 build.

**Branch:** `phase-1` · **For:** the project owner

Everything the build is waiting on you for, in one place: questions for a lawyer and for the accountant, business choices the agents made for you, the checks only a person signed in to the app can do, and the steps before go-live.

- **How to sign off.** Tick an item (`- [x]`) when it's confirmed or done. If you disagree, leave it unticked and add a note under it (for example `  - No: HR should approve this`). The next build step turns your notes into spec changes.
- **Kept up to date.** Each build step adds its new items here, with the next free ID. IDs never change or get reused, so you can refer to "R-042" in a message.
- **Where the detail is.** Each item links to its source. `#152` means row 152 of [HANDOFF › Assumptions to check](HANDOFF.md#assumptions-to-check), which has the full wording and the spec link.

Nothing here blocks the build. Check the lawyer, accountant and business items before HR enters real employee data, or before go-live where an item says so.

## 1. Needs a lawyer (counsel)

### Marked Legal in the build

- [ ] **R-001 · Service Incentive Leave** ([#152](HANDOFF.md#assumptions-to-check), [COMPLIANCE › Open questions](COMPLIANCE.md#open-questions)). Ask: the spec meets the 5-day SIL with VL, never converts unused leave to cash, and credits VL only from regularization. The Labor Code's implementing rules make unused SIL convertible to cash at year end, due after one year of service, Contractual employees included. Is the spec enough? Assumed: built as the spec says.
- [ ] **R-002 · Who may open a time off attachment** ([#206](HANDOFF.md#assumptions-to-check), RA 10173). Ask: is this access proportionate? Assumed: the employee, HR or the System Administrator with Talent Read, and any approver of that request (an Accounting user who approves as a supervisor included). Accounting as such never.
- [ ] **R-003 · The confidential label in messages** ([#210](HANDOFF.md#assumptions-to-check), RA 9262 Sec. 44). Ask: is this enough confidentiality for VAWC leave? Assumed: the cancel notice to approvers says "approved leave" without the type, the employee's own adjustment notice names their type, and the audit label is the request number only.

### Data privacy (RA 10173)

- [ ] **R-004 · Date of birth and civil status** ([#1](HANDOFF.md#assumptions-to-check)). Ask: must they be encrypted? Assumed: limited to HR, Accounting, the System Administrator and the employee, not encrypted, and visible in audit snapshots (System Administrator only).
- [ ] **R-005 · Medical certificates hidden from Accounting** ([#9](HANDOFF.md#assumptions-to-check)). Ask: is that the right reading of the reveal rules? Assumed: the medical rule wins, so Accounting doesn't see them.
- [ ] **R-006 · 201 documents kept forever** ([#12](HANDOFF.md#assumptions-to-check)). Ask: is keeping them indefinitely (archived, never erased, separated employees included) proportionate? Assumed: yes.
- [ ] **R-007 · Profile photos shown to every employee** ([#13](HANDOFF.md#assumptions-to-check)). Ask: is the company privacy notice enough consent? Assumed: yes.
- [ ] **R-008 · Receipts and routes aren't sensitive** ([#71](HANDOFF.md#assumptions-to-check)). Ask: is that acceptable, given pick-up and drop-off can show a home address and supervisors see them? Assumed: not encrypted.
- [ ] **R-009 · Receipt views aren't audit-logged** ([#72](HANDOFF.md#assumptions-to-check)). Ask: is that acceptable? Assumed: no log; GPS and other metadata are stripped from photos.
- [ ] **R-010 · The other claimant of a duplicate receipt is never named** to the employee ([#74](HANDOFF.md#assumptions-to-check)). Ask: is it fine that Talent Read users can still look them up with "Check a receipt"? Assumed: yes.
- [ ] **R-011 · A supervisor can work out a team member's date hired** from the timesheet's first day ([#59](HANDOFF.md#assumptions-to-check), [#76](HANDOFF.md#assumptions-to-check)). Ask: acceptable? Assumed: yes, since the supervisor works with the employee; the date itself is never sent.
- [ ] **R-012 · Supervisors and approvers see timesheets outside module access** ([#58](HANDOFF.md#assumptions-to-check), [#127](HANDOFF.md#assumptions-to-check), [#142](HANDOFF.md#assumptions-to-check)). Ask: acceptable? Assumed: read-only, with directory fields only about the employee.
- [ ] **R-013 · HR staff's government IDs and bank account** are verified by the System Administrator or a Board member, not HR ([#90](HANDOFF.md#assumptions-to-check)). Ask: right? Assumed: yes, as for changing them.
- [ ] **R-014 · Personal details changes go to HR only**, not supervisors ([#95](HANDOFF.md#assumptions-to-check)). Ask: right? Assumed: yes, since supervisors never see date of birth or civil status.
- [ ] **R-015 · Every leave attachment is treated as a medical file** ([#171](HANDOFF.md#assumptions-to-check)), Solo Parent IDs and VAWC certifications included, and none is copied into the 201 file. Ask: right? Assumed: yes.
- [ ] **R-016 · Time off and balances aren't sensitive** ([#172](HANDOFF.md#assumptions-to-check)). Ask: may supervisors, approvers and Talent Read see requests, types (not a confidential one), reasons and balances? Assumed: yes, read-only.
- [ ] **R-017 · A medical attachment is never previewed** in the request sheet ([#216](HANDOFF.md#assumptions-to-check)). Ask: right? Assumed: only the file name shows.

### VAWC leave (RA 9262)

- [ ] **R-018 · VAWC leave is confidential** ([#165](HANDOFF.md#assumptions-to-check)). Ask: is the routing right? Assumed: HR approves (the System Administrator for an HR requester), supervisors aren't asked, and everyone else sees only "Leave".
- [ ] **R-019 · Its approval title** ([#183](HANDOFF.md#assumptions-to-check)) reads "Leave (confidential): <name> · <days>", with no type and no attachment named. Ask: enough?
- [ ] **R-020 · It is left off the balance cards** for everyone but the employee, HR and the System Administrator ([#191](HANDOFF.md#assumptions-to-check)), since its limit would identify it. Ask: right?
- [ ] **R-021 · Its remarks are hidden too** ([#222](HANDOFF.md#assumptions-to-check)): approver remarks, cancel reason and approval history remarks. Ask: right?

### E-signatures, wages and attendance

- [ ] **R-022 · Uploaded e-signature images** ([#11](HANDOFF.md#assumptions-to-check), RA 8792). Ask: are they legally enough for approvals now, and for HR documents and contracts later? Assumed: yes.
- [ ] **R-023 · NCR-27 minimum wage isn't seeded** ([#31](HANDOFF.md#assumptions-to-check)). Ask: still right while its case is before the Supreme Court? Assumed: NCR-26 then NCR-28 (₱755 from 2026-09-26); HR adds a version if the Court revives NCR-27.
- [ ] **R-024 · How "beyond the schedule" is measured** ([#47](HANDOFF.md#assumptions-to-check), Labor Code Arts. 87–88). Ask: right? Assumed: arriving early counts only through the day's total, and a late start made up at the end of the day earns no overtime.
- [ ] **R-025 · Rest-day and holiday work counts only when marked** with a reason ([#48](HANDOFF.md#assumptions-to-check)). Ask: right? Assumed: yes, on both timesheet types.
- [ ] **R-026 · Lates** ([#128](HANDOFF.md#assumptions-to-check), [#138](HANDOFF.md#assumptions-to-check)). Ask: right? Assumed: late counts from the scheduled start once past the 15-minute grace period, in scheduled minutes only (the break isn't late time).
- [ ] **R-027 · Undertime** ([#129](HANDOFF.md#assumptions-to-check), Art. 88). Ask: right? Assumed: gaps in the middle of the day count, and staying late never makes up a late start.
- [ ] **R-028 · Partly covered days on the DTR** ([#173](HANDOFF.md#assumptions-to-check)). Ask: right? Assumed: late and undertime count only against the uncovered part; uncovered, unworked minutes become absent minutes, deducted in step 2.9.

### Leave law

- [ ] **R-029 · Who gets VL and SL** ([#151](HANDOFF.md#assumptions-to-check)). Ask: right? Assumed: only Regular employees with a regularization date; Probationary can't file VL or SL; Contractual employees get none.
- [ ] **R-030 · The seeded statutory leaves** ([#153](HANDOFF.md#assumptions-to-check)), none checked online. Ask: are maternity (105/120/60 days), paternity (7 days, 4 requests), solo parent (7), VAWC (10) and special leave for women (60) right, and open to Probationary, Regular and Contractual alike?
- [ ] **R-031 · Which leaves need an attachment** ([#155](HANDOFF.md#assumptions-to-check)). Ask: is the list right (SL a medical certificate, solo parent the Solo Parent ID, VAWC a barangay, police, prosecutor or court certification, and so on)?
- [ ] **R-032 · Statutory leave needs no minimum notice** ([#157](HANDOFF.md#assumptions-to-check)). Ask: right? Assumed: the law's own notice rules are left to HR.
- [ ] **R-033 · Sex-specific leaves read the record's sex** ([#174](HANDOFF.md#assumptions-to-check)). Ask: right? Assumed: paternity's marriage and cohabitation conditions are checked by HR, not the app.
- [ ] **R-034 · Service months count from the date hired** ([#175](HANDOFF.md#assumptions-to-check)), not RA 9710's "aggregate service in the last 12 months". Ask: acceptable?
- [ ] **R-035 · Per-year limits** ([#179](HANDOFF.md#assumptions-to-check)). Ask: right? Assumed: approved and pending requests count in each day's calendar year; paternity's 4 requests count approved ones ever with this company.

### Payroll computation (step 2.9)

Marked Legal in the step 2.9 spec. The accountant checks the same rows (see section 2).

- [ ] **R-211 · Contribution bases** ([#225](HANDOFF.md#assumptions-to-check), [COMPLIANCE › Open questions](COMPLIANCE.md#open-questions), item 7; RA 11199, RA 11223, RA 9679). Ask: which pay counts for SSS and Pag-IBIG? Assumed: PhilHealth on the monthly basic salary in effect on the first day of the contribution month; SSS and Pag-IBIG on the month's taxable pay less attendance deductions, from both cut-offs paid that month, with non-taxable allowances, de minimis within its limit and reimbursements left out.
- [ ] **R-212 · Withholding per cut-off** ([#228](HANDOFF.md#assumptions-to-check), RA 10963, RR 11-2018). Ask: right? Assumed: BIR's semi-monthly table on the cut-off's taxable pay, after the employee's SSS, PhilHealth and Pag-IBIG shares, never below 0; settlements from earlier cut-offs taxed in the cut-off they're paid; no annualization before step 2.12.
- [ ] **R-213 · A minimum wage earner's other pay** ([#229](HANDOFF.md#assumptions-to-check), [COMPLIANCE › Open questions](COMPLIANCE.md#open-questions), item 7; RR 11-2018). Ask: right? Assumed: the flag on the salary in effect on the pay date; basic, holiday, overtime, premium and night differential pay are exempt; taxable allowances and de minimis excess are still taxed on the semi-monthly table, with no contribution subtracted.
- [ ] **R-214 · De minimis excess is taxed in the cut-off it arises** ([#230](HANDOFF.md#assumptions-to-check), RR 2-98, RA 10963). Ask: right? Assumed: it isn't first pooled into the ₱90,000 ceiling for 13th month pay and other benefits; step 2.12's annualization reconciles it.
- [ ] **R-215 · The workday-before rule for holiday pay** ([#234](HANDOFF.md#assumptions-to-check), Labor Code Art. 94). Ask: right? Assumed: the workday before is the last scheduled work day before the holiday that isn't a holiday, rest days skipped. Present (even partly), paid leave or paid offset meets it; an absence, leave without pay or a day before the date hired doesn't; a worked holiday is always paid. While that day's timesheet isn't approved the rule counts as met.
- [ ] **R-216 · Unworked special days** ([#235](HANDOFF.md#assumptions-to-check), Art. 94). Ask: right? Assumed: monthly-rated employees aren't deducted (seeded `paid`, since the 261-day factor pays every day but rest days); daily-rated employees get `specialDayUnworked` (seeded 0).
- [ ] **R-217 · An unworked regular holiday on a rest day** ([#236](HANDOFF.md#assumptions-to-check), DOLE holiday pay rules). Ask: right? Assumed: paid at 100% under the workday-before rule, for monthly- and daily-rated employees alike, as a holiday pay line.
- [ ] **R-218 · Night differential** ([#238](HANDOFF.md#assumptions-to-check), Art. 86). Ask: right? Assumed: night minutes × the minute rate × the day's rate × 10%, without compounding the overtime add-on for night minutes inside overtime.
- [ ] **R-219 · Maternity leave in payroll** ([#243](HANDOFF.md#assumptions-to-check), [COMPLIANCE › Open questions](COMPLIANCE.md#open-questions), item 6; RA 11210). Ask: how should the SSS maternity benefit and the salary differential be split on the payslip, taxed, and reimbursed by SSS? Assumed: approved maternity leave is ordinary paid leave inside basic pay (full pay), with no benefit line, no split, no separate tax treatment and no tracking of SSS's reimbursement; the 30-day extension is leave without pay.
- [ ] **R-220 · Payroll run encryption and who sees amounts** ([#250](HANDOFF.md#assumptions-to-check), RA 10173). Ask: is this access proportionate? Assumed: every amount, totals included, is encrypted (category `payslip`); HR, Accounting and the System Administrator with Talent Read see runs; each "Show amounts" and breakdown is audited before any amount is sent; Board members and employees see nothing until step 2.10.
- [ ] **R-221 · Basic salary earned for 13th month pay** ([#254](HANDOFF.md#assumptions-to-check), PD 851). Ask: right? Assumed: basic pay less absences, leave without pay, late, undertime, partial-day absences and holiday deductions (settlements included); daily-rated holiday pay, overtime, premiums, night differential, allowances and reimbursements are left out.
- [ ] **R-251 · Holiday rules the spec leaves open** ([#261](HANDOFF.md#assumptions-to-check), Art. 94; from the build, for counsel and the accountant). Ask: right? Assumed: the base already paid for holiday work is what was actually paid that day; a special day worked on a rest day also gets a holiday pay line at `specialDayUnworked` (₱0 seeded); with `monthlyRatedUnworkedSpecialDay` `deducted`, the deduction waits for approval; provisional pay keeps every holiday pay line whose rule counts as met; the workday-before rule with no work day in the data is met unless the holiday is on or before the date hired.

### Not covered by the spec yet

- [ ] **R-036 · Retention of payroll, tax and accounting records** ([COMPLIANCE › Open questions](COMPLIANCE.md#open-questions), item 1). Ask counsel or the accountant how long payslips, payroll runs, invoices, books and receipt images must be kept.
- [ ] **R-037 · Data Privacy Act duties** ([COMPLIANCE › Open questions](COMPLIANCE.md#open-questions), item 2): a privacy notice to employees, a Data Protection Officer, and a breach reporting procedure to the National Privacy Commission.
- [ ] **R-038 · Consent for client signatures captured on phones** ([COMPLIANCE › Open questions](COMPLIANCE.md#open-questions), item 3).

## 2. Needs the accountant or payroll

Before the first real payroll, check every seeded rate against its latest issuance ([Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23)).

### Seeded rates

- [ ] **R-039 · SSS schedule** ([#27](HANDOFF.md#assumptions-to-check)): Circular No. 2024-006, 15% (5% employee, 10% employer). Still the latest on 2026-10-12; rows not re-read line by line.
- [ ] **R-040 · PhilHealth** ([#28](HANDOFF.md#assumptions-to-check)): 5%, half each, floor ₱10,000, ceiling ₱100,000. 2026 unchanged per secondary sources only.
- [ ] **R-041 · Pag-IBIG** ([#29](HANDOFF.md#assumptions-to-check)): 1% up to ₱1,500 then 2%, employer 2%, fund salary ₱10,000. Secondary sources only.
- [ ] **R-042 · BIR semi-monthly withholding table** ([#30](HANDOFF.md#assumptions-to-check)): RR 11-2018 Annex E. Secondary sources only.
- [ ] **R-043 · De minimis limits** ([#32](HANDOFF.md#assumptions-to-check)): RR 29-2025 from 2026-01-06 (rice ₱2,500 a month and the rest). The RR text wasn't read.
- [ ] **R-044 · 13th month and other benefits ceiling ₱90,000** ([#33](HANDOFF.md#assumptions-to-check)). House Bill 7661 (₱150,000) is pending.
- [ ] **R-045 · Premium rates** ([#34](HANDOFF.md#assumptions-to-check)): the spec's holiday, rest-day, overtime and night differential percentages, not re-checked. Check this year's DOLE holiday pay advisory.
- [ ] **R-046 · Not seeded** ([#40](HANDOFF.md#assumptions-to-check)): double holidays (300%), special working days, and the lower minimum wage for small employers (₱718 in NCR). Are any needed?

### Payroll rules

- [ ] **R-047 · Daily rate factor 261, 8 hours a day, contributions split half per cut-off** ([#36](HANDOFF.md#assumptions-to-check)).
- [ ] **R-048 · The internet allowance is non-taxable** ([#37](HANDOFF.md#assumptions-to-check)), though it isn't on BIR's de minimis list.
- [ ] **R-049 · Contribution basis** ([#39](HANDOFF.md#assumptions-to-check)), left to the payroll run step. Recommended: PhilHealth on basic salary; SSS and Pag-IBIG on the month's total taxable pay.
- [ ] **R-050 · Contribution rounding** ([#43](HANDOFF.md#assumptions-to-check)): PhilHealth premium rounded half-up once, employee half rounded, employer the rest; Pag-IBIG each share on its own. The agencies' own rounding wasn't checked.
- [ ] **R-051 · An entry past midnight belongs to the day it started** ([#50](HANDOFF.md#assumptions-to-check)). DOLE practice splits holiday hours by calendar day; settle before step 2.9 pays night work on a holiday eve.
- [ ] **R-052 · Night differential** ([#52](HANDOFF.md#assumptions-to-check)) counts paid minutes only, from the seeded night window.
- [ ] **R-053 · An unworked regular holiday** ([#130](HANDOFF.md#assumptions-to-check)) shows as "Holiday", never absent; whether it is paid (the day-before rule) is left to step 2.9.
- [ ] **R-054 · Maternity pay and the father's allocation** ([#154](HANDOFF.md#assumptions-to-check)): how the SSS benefit and salary differential are paid is step 2.9's; the up-to-7 days for the father aren't seeded.
- [ ] **R-055 · Year-to-date pay at go-live** ([#170](HANDOFF.md#assumptions-to-check)) holds seven figures. Does BIR Form 2316 also need non-taxable 13th month, de minimis and minimum wage earner pay?
- [ ] **R-056 · Year-to-date pay corrections** ([#189](HANDOFF.md#assumptions-to-check)) replace the latest entry in full, in whole centavos.

### Payroll run computation (step 2.9)

Also check the counsel items R-211 to R-221 and R-251, which name the accountant too. Every pay figure rests on these; see R-237 before the first real payroll.

- [ ] **R-222 · Contribution bases as a setting** ([#225](HANDOFF.md#assumptions-to-check)). The basis question is R-211. Check the seeded `talent.payrollRunSettings.contributionBases`, one per agency, as step 2.3 recommended (R-049).
- [ ] **R-223 · Contributions across the two cut-offs** ([#226](HANDOFF.md#assumptions-to-check)): the mid-month cut-off deducts half the month's contribution on the monthly basic salary, as an estimate; the end-of-month cut-off deducts the real month less the mid-month deduction, and refunds a negative remainder. Employer shares and EC split the same way.
- [ ] **R-224 · No mid-month run in a contribution month** ([#227](HANDOFF.md#assumptions-to-check)): the first payroll cut-off after go-live deducts only its own half of the estimate, on the view that the old system took the first half. An employee separated after the mid-month cut-off keeps the estimate; final pay (step 2.14) settles the rest.
- [ ] **R-225 · Basic pay formulas** ([#232](HANDOFF.md#assumptions-to-check)): monthly ÷ 2 for a whole cut-off; a salary change inside it shares monthly ÷ 2 by base days; a hire or separation inside it pays employed base days × each day's daily rate; daily-rated pays employed base days that aren't holidays × the daily rate.
- [ ] **R-226 · Unworked special days** ([#235](HANDOFF.md#assumptions-to-check)). The legal side is R-216. Check the seeded `monthlyRatedUnworkedSpecialDay` (`paid`) and `specialDayUnworked` (0).
- [ ] **R-227 · Premium formulas** ([#237](HANDOFF.md#assumptions-to-check)): holiday work in the first 8 hours pays the day's rate less the base already paid that day; minutes beyond 8 hours on a rest day or holiday pay the day's rate × 130%; ordinary overtime × 125%. Two holidays on one date count as one (300% isn't seeded).
- [ ] **R-228 · Attendance deductions** ([#239](HANDOFF.md#assumptions-to-check)): absences and leave without pay at the day's daily rate; late, undertime and partial-day absences at the minute rate (daily ÷ hours per day ÷ 60).
- [ ] **R-229 · Which settings version applies** ([#255](HANDOFF.md#assumptions-to-check)): contributions on the first day of the contribution month; withholding, de minimis and the 13th month ceiling on the pay date; premium rates, allowance types and minimum wages on each day; payroll and run settings on the cut-off's start. The run stores each version it used.
- [ ] **R-252 · De minimis in the engine** ([#263](HANDOFF.md#assumptions-to-check)): limits counted per de minimis key (two allowance types on one key share it), against finalized lines in the limit's period; the excess taxed on the latest lines first; a daily limit on an unapproved timesheet counts employed non-holiday base days as present; a key missing from the pay date's limits makes the whole amount taxable; an allowance type missing from the day's version counts as a taxable per cut-off allowance.
- [ ] **R-253 · Basic pay and bases at the edges** ([#264](HANDOFF.md#assumptions-to-check)): monthly ÷ 2 only when employed every calendar day of the cut-off; a base day with no salary earns nothing; the monthly basic salary basis falls back to the first salaried employed day; contribution bases below 0 count as 0; the minimum wage earner flag is the salary's on the pay date.
- [ ] **R-254 · How lines are keyed and shown** ([#265](HANDOFF.md#assumptions-to-check)): ₱0.00 lines left out; one holiday line per holiday and one allowance line per type and basis; deductions stored positive and settlements signed on their own side; the SSS line includes the MPF share (the breakdown keeps the split).
- [ ] **R-255 · What a run reads, and its window** ([#269](HANDOFF.md#assumptions-to-check)): the lookback of the run's own settings version plus one more cut-off for the workday-before rule; each earlier period computed with the settings in effect on its own start; a period in the lookback with no run at all is settled in full (its attendance items, not its basic pay) by the next run.
- [ ] **R-256 · The mid-month pairing and de minimis periods** ([#272](HANDOFF.md#assumptions-to-check)): an end-of-month run reads the same month's mid-month run whatever its status; an employee with no line in it is treated as having no mid-month run (estimate only); de minimis already paid counts finalized lines whose pay date falls in the same month, semester or year.
- [ ] **R-258 · The minimum wage region is the current one** ([#285](HANDOFF.md#assumptions-to-check)): the minimum wage earner and de minimis checks use the employee's work region on the record now for the whole window (`DEFAULT_WORK_REGION` when none is set); there is no region history, so a move between regions inside a run's window uses the new region throughout. Also for counsel.

### Receipts and reimbursements

- [ ] **R-057 · A merchant TIN with no branch code is the head office** (`00000`), and the branch code is part of the duplicate check ([#62](HANDOFF.md#assumptions-to-check)).
- [ ] **R-058 · Receipt-number matching ignores case, separators and leading zeros** ([#63](HANDOFF.md#assumptions-to-check)): `OR-000123` = `OR 123` and `SI-0042` = `SI42`, but a zero after a digit is kept, so `2026-0001` stays `20260001`. Could two genuinely different receipts collide?
- [ ] **R-059 · Invoices count as receipts** under RA 11976 and RR 7-2024 ([#64](HANDOFF.md#assumptions-to-check)).
- [ ] **R-060 · The app doesn't check a receipt is made out to the company** ([#65](HANDOFF.md#assumptions-to-check)). Is that needed to keep reimbursements non-taxable and deductible?
- [ ] **R-061 · Deleting a reimbursement line frees its receipt** for anyone to claim ([#69](HANDOFF.md#assumptions-to-check)).
- [ ] **R-062 · A ride with no receipt** (jeepney, tricycle) can't be claimed ([#73](HANDOFF.md#assumptions-to-check)).

### Formats and placeholder company data

- [ ] **R-063 · ID and account formats** ([#2](HANDOFF.md#assumptions-to-check)): TIN 9, 12 or 14 digits; SSS 10; PhilHealth and Pag-IBIG 12; UnionBank and RCBC accounts 10 to 16 digits; mobile 11 digits from `09`. Confirm with HR and the banks.
- [ ] **R-064 · Company details are still placeholders** ([DEPLOYMENT › Going live](DEPLOYMENT.md#going-live), step 2). Enter the registered name, address, TIN and RDO code, employer SSS, PhilHealth and Pag-IBIG numbers and BIR details in company settings; until then documents show `[Company TIN]` and the like.

## 3. Business decisions to confirm

The choices a business owner would most want to decide. Each was built as described; say no and the next step changes it.

### Who approves what

- [ ] **R-065 · HR's own time off goes to the System Administrator** ([#164](HANDOFF.md#assumptions-to-check)), while HR's own timesheet goes to the other HR users. Keep the difference?
- [ ] **R-066 · Supervisors approve their team's change requests but don't edit records** ([#96](HANDOFF.md#assumptions-to-check), also for counsel). The handoff calls this the 2.6 item most worth your look.
- [ ] **R-067 · Approving without an e-signature is refused** ([#89](HANDOFF.md#assumptions-to-check)); only the bootstrap system account still approves unsigned.
- [ ] **R-068 · Routing of sensitive changes** ([#97](HANDOFF.md#assumptions-to-check)): government IDs and bank to HR, HR staff's to any one Board member, the System Administrator only when no one else is left.
- [ ] **R-069 · Deciding a change request needs no module access** ([#98](HANDOFF.md#assumptions-to-check)), like every approval.
- [ ] **R-070 · A pending request can't be withdrawn** ([#100](HANDOFF.md#assumptions-to-check), [#166](HANDOFF.md#assumptions-to-check)): the employee asks the approver to return it, then cancels. An approved leave can be cancelled before its first day.
- [ ] **R-071 · Onboarding status is for HR and the System Administrator only** ([#101](HANDOFF.md#assumptions-to-check)), so nobody else can tell who has IDs or a bank account on file.
- [ ] **R-072 · The onboarding gates are code, not a setting** ([#88](HANDOFF.md#assumptions-to-check)).
- [ ] **R-073 · The timesheets list is open to Talent Read**, not HR only ([#135](HANDOFF.md#assumptions-to-check)).

### Timesheets and offset

- [ ] **R-074 · Late timesheets are accepted** and marked "Submitted late" ([#124](HANDOFF.md#assumptions-to-check)); submission opens the day after the cut-off ends.
- [ ] **R-075 · The deadline is 1 day after the cut-off** ([#123](HANDOFF.md#assumptions-to-check)), changeable from 1 to 10.
- [ ] **R-076 · A submitted timesheet can't be changed or withdrawn**, and an approved one is never reopened ([#125](HANDOFF.md#assumptions-to-check)).
- [ ] **R-077 · Approval is all or nothing** ([#126](HANDOFF.md#assumptions-to-check)): to drop one overtime claim or reimbursement, the approver returns the whole timesheet.
- [ ] **R-078 · HR can't correct an employee's time entries** ([#54](HANDOFF.md#assumptions-to-check)); corrections come through a return.
- [ ] **R-079 · A timesheet with no entries can be submitted** ([#131](HANDOFF.md#assumptions-to-check)), with a warning that every day shows absent.
- [ ] **R-080 · The DTR is never stored** ([#137](HANDOFF.md#assumptions-to-check)): after a holiday change, a paid period's DTR on screen shows the new figures until step 2.9 stores what was paid.
- [ ] **R-081 · The offset balance may go below zero** after a holiday change ([#133](HANDOFF.md#assumptions-to-check), [#167](HANDOFF.md#assumptions-to-check)), and the employee is told.
- [ ] **R-082 · Offset is earned 1:1** ([#53](HANDOFF.md#assumptions-to-check)).
- [ ] **R-083 · The 12:00 to 13:00 break is always deducted** ([#46](HANDOFF.md#assumptions-to-check)), even when someone works through it.
- [ ] **R-084 · No minimum overtime block** and no rounding to 15 or 30 minutes ([#51](HANDOFF.md#assumptions-to-check)).
- [ ] **R-085 · Reminder days** ([#134](HANDOFF.md#assumptions-to-check)): the employee on the opening day, the deadline day and the day after; HR once, the day after the deadline. Separated employees get none ([#136](HANDOFF.md#assumptions-to-check)).

### Leave

- [ ] **R-086 · Leave in half days, and the regularization credit prorated** ([#150](HANDOFF.md#assumptions-to-check)): regularized April 10 gives 4.0 days, April 20 gives 3.5.
- [ ] **R-087 · VL must be filed 14 calendar days ahead** ([#158](HANDOFF.md#assumptions-to-check)).
- [ ] **R-088 · Pending requests hold balance**, and a future credit is never counted ([#159](HANDOFF.md#assumptions-to-check)).
- [ ] **R-089 · Leave can't be filed over worked time** ([#160](HANDOFF.md#assumptions-to-check)).
- [ ] **R-090 · Offset time off** ([#162](HANDOFF.md#assumptions-to-check)): at least 1 hour in 30-minute steps, and it must start after it is filed, so it never covers a late or absence already incurred.
- [ ] **R-091 · Opening balances and corrections** ([#169](HANDOFF.md#assumptions-to-check)): one VL, SL and offset opening per employee; mistakes fixed by an adjustment with a reason.
- [ ] **R-092 · Leave is credited daily at 00:30**, with no "leave credited" notification ([#176](HANDOFF.md#assumptions-to-check)).
- [ ] **R-093 · Disabled accounts still get credits**; only separated employees are skipped ([#187](HANDOFF.md#assumptions-to-check), [#224](HANDOFF.md#assumptions-to-check)).

### Pay, settings and the employee record

- [ ] **R-094 · Pay dates don't move** for weekends or holidays ([#35](HANDOFF.md#assumptions-to-check)).
- [ ] **R-095 · A wrong settings version can't be withdrawn**, only replaced from a later date ([#41](HANDOFF.md#assumptions-to-check)).
- [ ] **R-096 · Nothing stops the internet allowance at separation yet** ([#42](HANDOFF.md#assumptions-to-check)); the payroll and final pay steps decide.
- [ ] **R-097 · No reimbursement limits are seeded** ([#66](HANDOFF.md#assumptions-to-check)); HR adds them.
- [ ] **R-098 · The checklist's required fields** ([#84](HANDOFF.md#assumptions-to-check)) and **required documents** (government ID copy and NBI clearance, [#85](HANDOFF.md#assumptions-to-check)).
- [ ] **R-099 · An employee with no supervisor is blocked** from submitting timesheets and filing time off until someone confirms "No supervisor" ([#86](HANDOFF.md#assumptions-to-check)).
- [ ] **R-100 · Values saved before step 2.6 read as not verified**, so HR verifies each existing employee once ([#91](HANDOFF.md#assumptions-to-check)).
- [ ] **R-101 · Employees fill empty fields directly**, even after onboarding; only changing a filled value needs approval ([#92](HANDOFF.md#assumptions-to-check)).
- [ ] **R-102 · Employees upload their own 201 documents** (not the contract or regularization evaluation) and add their own certifications directly ([#93](HANDOFF.md#assumptions-to-check), [#94](HANDOFF.md#assumptions-to-check)).
- [ ] **R-103 · An approved change overwrites a value changed meanwhile**, with no conflict check ([#99](HANDOFF.md#assumptions-to-check)).
- [ ] **R-104 · A save that changes nothing still writes an audit entry** ([#6](HANDOFF.md#assumptions-to-check); also 1.8 [judgement call](HANDOFF.md#judgement-calls-left-for-the-user) 2). Or should it write nothing?
- [ ] **R-105 · "Not filled in" hides that a salary is stored** from anyone who may not see pay ([#7](HANDOFF.md#assumptions-to-check)).
- [ ] **R-106 · The 201 document types** ([#10](HANDOFF.md#assumptions-to-check)), **expiry alert defaults** (30 days ahead, [#15](HANDOFF.md#assumptions-to-check)) and **skills as free-text tags** ([#16](HANDOFF.md#assumptions-to-check)).

### Payroll runs (step 2.9)

- [ ] **R-230 · Provisional pay** ([#240](HANDOFF.md#assumptions-to-check)): a cut-off whose timesheet isn't approved pays basic pay, per cut-off allowances and daily-rated holiday pay, with contributions and tax; overtime, premiums, night differential, reimbursements and attendance deductions wait for the approval and settle in a later cut-off.
- [ ] **R-231 · No automatic back pay** ([#241](HANDOFF.md#assumptions-to-check)): a finalized period's basic pay and allowances are never recomputed, so a back-dated salary or allowance change needs a manual back pay line (step 2.10). This keeps it from ever being paid twice.
- [ ] **R-232 · Settlements look back 24 cut-offs (a year)** ([#242](HANDOFF.md#assumptions-to-check)), against finalized runs only; older changes need a manual line.
- [ ] **R-233 · Reimbursements are paid in net pay** ([#244](HANDOFF.md#assumptions-to-check)), as one non-taxable line per approved timesheet, not paid separately.
- [ ] **R-234 · Net pay below zero is kept as computed** ([#245](HANDOFF.md#assumptions-to-check)) and marked "Net pay below zero"; nothing is capped or carried forward, and HR resolves it in step 2.10's review.
- [ ] **R-235 · The go-live date sets the first payroll cut-off** ([#247](HANDOFF.md#assumptions-to-check)): the first cut-off starting on or after it. No run can be created until it's set, and a cut-off cut by go-live stays with the old system. See R-239.
- [ ] **R-236 · Drafts are created and refreshed by a nightly job** ([#248](HANDOFF.md#assumptions-to-check)) at 05:00, once every timesheet is approved or the deadline has passed. Approvals don't recompute drafts by themselves, so HR recomputes before reviewing.
- [ ] **R-240 · Everyone employed with no salary is listed as left out** ([#267](HANDOFF.md#assumptions-to-check)) on every run ("No salary on file"), Board members and staff paid outside payroll included. Or should some people be kept off the run altogether?
- [ ] **R-241 · Only the nightly job's draft notifies HR** ([#268](HANDOFF.md#assumptions-to-check)); a draft HR computes by hand notifies no one.
- [ ] **R-242 · Payroll amounts are hidden again after every reload or recompute** ([#278](HANDOFF.md#assumptions-to-check)): "Show amounts" lasts one page view, and each time amounts are shown, and each breakdown opened, is a separate entry in the audit log.
- [ ] **R-257 · Premiums follow the extra-hours treatment, not the timesheet type's name** ([#262](HANDOFF.md#assumptions-to-check)). Seeded: Overtime timesheet → overtime, Standard → offset. If HR ever maps the Standard type to overtime, its claimed hours are paid.

### Step 1.8 judgement calls

- [ ] **R-107 · The duplicate client name check needs Engage Write**, not Read ([judgement call 1](HANDOFF.md#judgement-calls-left-for-the-user)).
- [ ] **R-108 · A retired client offers no sites or contacts** in pickers ([judgement call 3](HANDOFF.md#judgement-calls-left-for-the-user)).
- [ ] **R-109 · HR's `/admin` overview shows a "People and organization" heading** ([1.8 notes](HANDOFF.md#judgement-calls-left-for-the-user)). Keep it?

### Everything else

- [ ] **R-110 · Skim the rest.** The remaining rows of [Assumptions to check](HANDOFF.md#assumptions-to-check), the [1.7 assumptions](HANDOFF.md#assumptions-list-for-the-user) and the [1.11 notes](HANDOFF.md#assumptions-and-small-notes-for-the-user) are mostly wording, layout and technical choices. Read them only if you want to; a row you leave alone stays as built.

## 4. Hands-on checks in the app

Agents have no browser, so a person signed in has to do these. Unless an item says otherwise, check in light and dark appearance and at phone width (about 390 px) with no sideways scroll.

### 1.7 User access ([Not done](HANDOFF.md#not-done))

- [ ] **R-111** The "Done when": as HR on `/admin/access`, set Talent Write for a user; Talent shows in their sidebar; `/admin/audit` shows None → Write.
- [ ] **R-112** HR's own row is read-only.
- [ ] **R-113** The sheet's dialogs, the "Needs access" group and the sidebar count.
- [ ] **R-114** Light, dark and phone width.

### 1.8 Shared master data ([Manual checks still needed](HANDOFF.md#manual-checks-still-needed-by-a-person-signed-in))

- [ ] **R-115** The "Done when": on `/admin/clients`, add a client with two sites and a primary contact; `/admin/products` shows all 13 products; `/admin/audit` shows the entries.
- [ ] **R-116** The duplicate client name warning and "Save anyway"; editing the name clears them.
- [ ] **R-117** Products: retire refused while live catalog items exist, otherwise retire and restore. Catalog items: non-stock sets warranty to 0; product and kind locked on edit. Suppliers: up to 20 contacts, and the products picker.
- [ ] **R-118** HR gets the no-access state on the four pages and sees no sidebar entries for them.
- [ ] **R-119** Departments: the head picker still searches and saves.
- [ ] **R-120** Light, dark and phone width on the four pages and the client sheet.

### 1.9 Approvals ([1.9 brief](HANDOFF.md#step-19-brief-done))

No checklist in HANDOFF; these come from the owner's notes.

- [ ] **R-121** Start from a fresh development database (requests from before `decidedFor` existed don't show under Decided).
- [ ] **R-122** `pnpm dev:approval --requester <email> --step supervisors` for someone with 2+ supervisors: approve as one; the others get "Settled by …" and see it under Decided.
- [ ] **R-123** `pnpm dev:approval --requester <email> --step self`: a System Administrator gets it.
- [ ] **R-124** `/approvals` and the inspector in light, dark and phone width.

### 1.10 Holidays ([1.10 brief](HANDOFF.md#step-110-brief-done))

No checklist in HANDOFF; these come from the owner's notes.

- [ ] **R-125** Run `pnpm seed:admin`; as HR on `/holidays`, run the auto-draft for next year and check Holy Week (2027: Mar 25, 26, 27).
- [ ] **R-126** A non-HR user sees only confirmed holidays.
- [ ] **R-127** Edit then confirm; "Confirm all" with a missing legal basis; Declare (everyone notified but the declarer); delete.
- [ ] **R-128** Light, dark and phone width.

### 1.11 Directory, org chart, command bar and Home ([1.11 manual checks](HANDOFF.md#111-manual-checks-by-the-user-signed-in))

- [ ] **R-129** The "Done when": an employee with two supervisors shows once with two lines on `/org-chart`.
- [ ] **R-130** ⌘K or Ctrl+K finds a person by name and by employee number, and opens their card.
- [ ] **R-131** `/directory`: search, department filter, "Show separated" for HR; `?separated=1` does nothing for an ordinary user.
- [ ] **R-132** Reporting lines in the inspector as a Board member (⌘↵ saves; own lines refused; one audit entry; the stale message in two tabs).
- [ ] **R-133** `/admin/users`' supervisor picker still works.
- [ ] **R-134** Home: greeting, the four tiles and their zero states; the system account sees no name and no Your team tile.
- [ ] **R-135** Org chart zoom, Fit, department filter and name search, by keyboard and at phone width.

### 2.1 Employee record ([2.1 hands-on checks](HANDOFF.md#21-hands-on-checks-by-the-user-signed-in))

Setup first: [#5](HANDOFF.md#assumptions-to-check) (give HR Talent access, and create a Talent Write user outside HR, Accounting and the Board).

- [ ] **R-136** The "Done when": HR reveals a TIN; the System Administrator finds the `reveal` in `/admin/audit`; the Talent Write user sees no sensitive sections.
- [ ] **R-137** Each salary and bank reveal adds one audit entry; hide and reveal again adds another.
- [ ] **R-138** Editing: each sheet saves; a same-date salary correction shows "Superseded"; the two-tab stale message; HR can't edit an HR colleague's IDs, bank or salary.
- [ ] **R-139** ⌘S or Ctrl+S saves, Escape closes.
- [ ] **R-140** `/talent/me` as an ordinary user and as the system account.
- [ ] **R-141** Light, dark and phone width.

### 2.2 201 file, photo, e-signature, certifications ([2.2 hands-on checks](HANDOFF.md#22-hands-on-checks-by-the-user-signed-in))

Setup first: [#18](HANDOFF.md#assumptions-to-check) (HR Talent Write, Accounting Talent Read, one Talent Owner, an employee with a supervisor).

- [ ] **R-142** The "Done when", signatures: approve with signature version 1, replace it, approve again with version 2; no signature reads "Approved without an e-signature".
- [ ] **R-143** The "Done when", expiry alerts with `pnpm dev:expiry-alerts`: right recipients, nothing new on a second run, "expired" once; no file name or title in any notification.
- [ ] **R-144** Opening a 201 document adds a `reveal` entry; Accounting can't see a medical certificate; a copied link gives "File not found." to others.
- [ ] **R-145** Uploads end to end (PDF, JPEG, photo, signature; HEIC and oversize refused; archive, renew; the lead-days setting once a day).
- [ ] **R-146** The photo shows everywhere (directory, org chart, access page, approvals, Talent, command bar).
- [ ] **R-147** Light, dark and phone width (the signature stays readable in dark).

### 2.3 Payroll settings ([2.3 hands-on checks](HANDOFF.md#23-hands-on-checks-by-the-user-signed-in))

- [ ] **R-148** `pnpm seed:admin` twice on a fresh database: ten `talent.*` loaders, then all `added 0`.
- [ ] **R-149** The "Done when", allowance: a new hire shows the ₱500 internet allowance per cut-off, with nothing stored.
- [ ] **R-150** The "Done when", warning: ₱16,000 a month in NCR warns against ₱755.00 and needs "Save anyway"; a region with no rate shows its note.
- [ ] **R-151** Adding a payroll settings version (audit entry; earlier dates refused; no "Add version" for a Talent Owner outside HR).
- [ ] **R-152** The wage order list: counts and names, no amounts; hidden from the wrong users.
- [ ] **R-153** Allowances: assign, reveal (audited), end; read-only on `/talent/me`.
- [ ] **R-154** Light, dark and phone width (the SSS and tax grids scroll inside their own box).

### 2.4 Work schedules and time entries ([2.4 hands-on checks](HANDOFF.md#24-hands-on-checks-by-the-user-signed-in))

- [ ] **R-155** `pnpm seed:admin` adds the work schedule and timesheet settings once.
- [ ] **R-156** The "Done when" on a phone: the hand cases for a Driver (2.0 h; 6.5 h plus 1.5 h night) and an office employee (offset 2.6 h, "Manual").
- [ ] **R-157** Time in and Time out, and "Manual" after editing a time.
- [ ] **R-158** A supervisor without Talent access sees the team member's timesheet read-only; others get no access.
- [ ] **R-159** Set schedule in the inspector (audited; HR can't set their own); read-only on `/talent/me`.
- [ ] **R-160** The Work schedule tab in Payroll settings.
- [ ] **R-161** Light, dark and phone width.

### 2.5 Reimbursements ([2.5 hands-on checks](HANDOFF.md#25-hands-on-checks-by-the-user-signed-in))

- [ ] **R-162** `pnpm seed:admin` adds the reimbursement settings once.
- [ ] **R-163** The "Done when": employee B's claim of A's receipt (TIN typed differently) is refused without naming A; A's own second try names the date and type.
- [ ] **R-164** Deleting A's line frees the receipt; audit shows create and delete.
- [ ] **R-165** Required fields per type, and the filing window.
- [ ] **R-166** A per-day meal limit: lines over it show "Over limit" and still save.
- [ ] **R-167** Supervisor and Talent Read views open the receipt; others can't; "Check a receipt" finds the claimant.
- [ ] **R-168** Light, dark and phone width (a phone offers the camera).

### 2.6 Onboarding and change requests ([2.6 hands-on checks](HANDOFF.md#26-hands-on-checks-by-the-user-signed-in))

- [ ] **R-169** Rerun `pnpm seed:admin` on the existing development database (adds the onboarding settings once).
- [ ] **R-170** The "Done when": a new user skips the checklist and keeps working; their Approve is refused naming "E-signature"; after uploading one it succeeds, signed.
- [ ] **R-171** The checklist's states and each To do row's action.
- [ ] **R-172** The toolbar pill ("5/8" on a phone) and the Home card.
- [ ] **R-173** My record: filling an empty field saves at once, changing a filled one sends a request; "Upload document", "Add certification", the Change requests list.
- [ ] **R-174** A change request: approve, return, reject; "Edit and send again" and Cancel; the record changes only on approve.
- [ ] **R-175** The inspector's Onboarding section: "Mark verified" and "Confirm no supervisor".
- [ ] **R-176** `/talent`'s onboarding tiles and filter (HR and System Administrator only), and Settings › Required onboarding documents.
- [ ] **R-177** The Approvals gate notice for an approver with no e-signature.
- [ ] **R-178** Light, dark and phone width.

### 2.7 Timesheet approval and the DTR ([2.7 hands-on checks](HANDOFF.md#27-hands-on-checks-by-the-user-signed-in))

- [ ] **R-179** On a phone, light and dark: status banner, Submit sheet and its problem links, DTR segment, Offset card.
- [ ] **R-180** My team status badges; `/talent/timesheets` with the cut-off picker, filters and a red "Overdue" row.
- [ ] **R-181** Approvals: "Open in Approvals", approve as supervisor then HR; a return with remarks.
- [ ] **R-182** The "Done when" on a phone: a returned Standard timesheet resubmitted, approved twice, "Approved · Locked", offset credited.
- [ ] **R-183** The deadline field in Payroll settings › Work schedule; blank refused.
- [ ] **R-184** `pnpm dev:timesheet-reminders --date <deadline>` after seeding a few open timesheets: employees' and HR's notifications.
- [ ] **R-185** A holiday change inside an approved, credited period writes an adjustment and notifies the employee.

### 2.8 Leave and offset time off ([2.8 hands-on checks](HANDOFF.md#28-hands-on-checks-by-the-user-signed-in))

Setup first: rerun `pnpm seed:admin` (see section 5) and set a go-live date in Payroll settings › Leave.

- [ ] **R-186** The "Done when" on a phone, throwaway database: VL 10 days ahead refused (L1); a whole day of offset approved shows "Offset (paid) 8.0 h" and the balance drops 8.0 h (O5).
- [ ] **R-187** Every new screen in light, dark and phone width; cancel a request and resend a returned one.
- [ ] **R-188** VAWC: goes to HR only; everyone else sees only "Leave", never the type, reason, attachment, remarks or cancel reason.
- [ ] **R-189** An HR requester with no supervisor waits for the System Administrator.
- [ ] **R-190** The SL attachment: each open by the employee, HR and the approving supervisor is audited; Accounting and an unrelated supervisor get not found.
- [ ] **R-191** Year-to-date pay: masked until revealed, and the reveal is audited (category `salary`).
- [ ] **R-192** The go-live date locks after the first opening entry.
- [ ] **R-193** `pnpm dev:leave-credits` with and without `--date` (a January 1, a regularization day): counts print, a second run writes nothing, balances show the credits.

### 2.9 Payroll run computation ([2.9 hands-on checks](HANDOFF.md#29-hands-on-checks-by-the-user-signed-in))

Setup first: rerun `pnpm seed:admin` (see section 5) and, on a throwaway database, set the go-live date on a cut-off start (2026-09-26) in Payroll settings › Leave.

- [ ] **R-243** The "Done when": the Sep 26 – Oct 10, 2026 draft with one Overtime and one Standard employee; their breakdowns match cases P1 and P2 (net ₱11,595.20 and ₱11,092.74).
- [ ] **R-244** Each "Show amounts" writes a `reveal` (field `amounts`) visible in `/admin/audit`; a reload hides the amounts again.
- [ ] **R-245** Each breakdown opened writes a `reveal` (field `breakdown`), with no amount in the entry.
- [ ] **R-246** A Talent Read user who isn't HR, Accounting or the System Administrator gets no "Payroll" button and no access to `/talent/payroll` or a run; Accounting sees runs but can't compute or recompute.
- [ ] **R-247** "Recompute" after changing an input: the lines and "Computed <when>" update, and the audit log has an `update` ("Recomputed") with no amount.
- [ ] **R-248** `pnpm dev:payroll-drafts` with and without `--date`: it prints the dates and the draft created or why not; a second run creates nothing; HR is notified only for the job's draft.
- [ ] **R-249** Payroll settings › Pay schedule › Payroll run: the card shows the seeded choices, and "Add version" saves.
- [ ] **R-250** Light, dark and phone width: `/talent/payroll` and its sheet, the run page, the breakdown sheet, and the Payroll run card and its sheet.
- [ ] **R-259** Accounting reads only: it sees the runs, "Show amounts" and the breakdowns (each writing its `reveal`), but no "Compute draft run" or "Recompute", and a direct call of either action is refused.
- [ ] **R-260** An employee and a Board member (Talent Read, but not HR, Accounting or the System Administrator) get no access to `/talent/payroll` or a run, and the generic sensitive reveal of a draft line, their own included, is refused ([#284](HANDOFF.md#assumptions-to-check)).
- [ ] **R-261** Confirming or adding a holiday on a date inside a draft run's window recomputes the draft after the holidays-changed job.
- [ ] **R-262** With the go-live date set and an ended cut-off without a run, `pnpm dev:payroll-drafts` creates one draft and sends HR one notification; a rerun creates nothing, sends nothing and only recomputes the drafts.

## 5. Before going live, and housekeeping

### Before real data or go-live

- [ ] **R-194 · Generate the production `FIELD_ENCRYPTION_LOCAL_KEY` on the real server** before any real employee data, and keep an offline copy off the server ([#4](HANDOFF.md#assumptions-to-check)). Never put real data in a development database.
- [ ] **R-195 · Encrypted disk for `storage/`** (201 files, medical certificates), backed up with the database and the key ([#14](HANDOFF.md#assumptions-to-check)). The app doesn't encrypt stored files.
- [ ] **R-196 · Key rotation tooling**: decide whether to build a re-wrap tool before go-live, and how often to rotate ([#3](HANDOFF.md#assumptions-to-check)).
- [ ] **R-197 · The rest of [DEPLOYMENT › Still to decide](DEPLOYMENT.md#still-to-decide)**: where it runs, URL and TLS, releases and rollback, backups with a tested restore, monitoring.
- [ ] **R-198 · Set the go-live date** in Payroll settings › Leave before go-live ([#168](HANDOFF.md#assumptions-to-check)). No credit or opening entry is written until it's set, and it locks after the first opening entry.
- [ ] **R-237 · Accountant sign-off on pay before the first real payroll.** The hand calculations P1 and P2 (and P3 to P12) in [Payroll run computation](modules/talent.md#payroll-run-computation-build-step-29) and every pay formula (R-211 to R-229, and R-251 to R-256 from the build) are the agents' reading of the law, checked by no one yet. Their salaries and dates are invented test data ([#256](HANDOFF.md#assumptions-to-check)).
- [ ] **R-238 · Check every seeded payroll rate** against the latest issuances ([Seeded payroll rates](COMPLIANCE.md#seeded-payroll-rates-build-step-23)) before the first real payroll, as section 2 says.
- [ ] **R-239 · Set the go-live date on a cut-off start** (the 26th or the 11th, as seeded) ([#247](HANDOFF.md#assumptions-to-check)), so the first payroll cut-off begins on it (R-198, R-235).

### Development database

- [ ] **R-199 · Rerun `pnpm seed:admin` on existing development databases** after steps 2.6, 2.8 and 2.9 (it adds the onboarding, leave and payroll run settings; a second run adds nothing). The real local `xtreme-pulse` database has base data but no users yet ([Local environment](HANDOFF.md#local-environment)).

### Phase 1

- [ ] **R-200 · The Phase 1 check** ([BUILD_PLAN › Phase 1](BUILD_PLAN.md#phase-1-pulse-core)), skipped so far by your choice. On a fresh database, with typecheck and lint passing, in light, dark and phone width:
  - run `pnpm seed:admin`, sign in as sysadmin@xtreme-works.com, set a new password and fill in one company detail
  - create a Human Resource Officer, sign in as HR, change the temporary password, and create two employees, one reporting to the other
  - set their access on `/admin/access`, then sign in as each: sidebar, directory, org chart, command bar
  - confirm next year's holidays, run a sample approval, set an employee to Resigned, and check the sign-out and the audit log

### Git

- [ ] **R-201 · Push `phase-1` and open a pull request to `main`**, only when you ask. `phase-1` is pushed up to step 1.8; everything since (1.9 to 2.9) is committed but not pushed ([Branches and commits](HANDOFF.md#branches-and-commits)).

### Known small gaps, left on purpose

Tick to accept as is, or add a note to have one fixed (some need a spec change).

- [ ] **R-202** The Approvals "Decided" rows show the submitted time but are sorted by decision time.
- [ ] **R-203** The same-date holiday warning is non-blocking, with no "Save anyway".
- [ ] **R-204** The same-name, same-date holiday check has no unique index, so two adds at the same instant could both get through.
- [ ] **R-205** The supervisor search can show 19 results instead of 20 ([1.11 notes](HANDOFF.md#assumptions-and-small-notes-for-the-user)).
- [ ] **R-206** There's no `/dev` page for `pnpm dev:approval`.

### Housekeeping ([Open items for later steps](HANDOFF.md#open-items-for-later-steps))

- [ ] **R-207** Delete the verifier test files in `storage/2026/09/` (git-ignored, safe).
- [ ] **R-208** Drop the leftover local database `xtreme-pulse-verify12`.
- [ ] **R-209** Known issue, not fixed: `insertMany` inside a transaction waits for indexes instead of failing fast (`packages/db/src/define-model.ts`, [Known issue](HANDOFF.md#known-issue-outside-step-08-not-fixed)). Decide whether to fix it.
- [ ] **R-210** Optional: expand the `.env.example` `AUTH_TRUST_HOST` comment to mention the "UntrustedHost" error.
