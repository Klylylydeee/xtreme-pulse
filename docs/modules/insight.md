# Pulse Insight (Business Intelligence)

Read-only dashboards across every module. Insight never changes other modules' data.

Built in [Phase 7](../BUILD_PLAN.md#phase-7-pulse-insight). Route: `/insight`. Package: `packages/insight`. Insight only reads other modules (see [Architecture rules](../ARCHITECTURE.md#architecture-rules)), and the access levels it depends on are in [Module access](../../SECURITY.md#module-access-rwo).

## Dashboards

- **Executive:** revenue, pipeline, cash position, receivables and payables, project health, SLA compliance, and progress against targets.
- **Sales** (from Pulse Engage): pipeline by stage, business line and product; win rate; quota attainment per person and team; renewals coming up.
- **Operations** (from Pulse Ops and Pulse Supply): projects by stage, projects on hold, milestones ready to bill, rollout progress, and delivery status (ordered vs delivered).
- **Support** (from Pulse Desk): open tickets by queue and priority, SLA compliance and breaches, POS fleet status, upcoming renewals.
- **Finance** (from Pulse Fiscal): cash position, AR and AP aging, revenue vs collections, upcoming tax due dates.
- **People** (from Pulse Talent): headcount by department and status, attendance (absences, lates), leave usage, overtime and offset hours. Never salaries or anyone's pay.

## Who sees what

- A person sees only the figures from modules they have at least Read access to (see [Module access](../../SECURITY.md#module-access-rwo)), except Board of Directors members with Insight Read (see the Board exception below). A dashboard with nothing they can access isn't shown.
- Figures follow each module's record visibility: people see totals built only from records they could open (e.g. pipeline value from the deals they're on). Owners of that module and Board of Directors members see company totals.
- **Board exception:** Board of Directors members with Insight Read see company-wide totals for every module, on the dashboards and in the weekly Board summary, even modules where they have None. The exception applies only inside Insight: a Board member still needs Insight Read to open Insight, and HR or the System Administrator grants it like any other access. It covers aggregate figures only. Opening or drilling into the underlying records still needs module access and follows each module's record visibility (deal team, project team, and so on).
- Drill-downs open the underlying records only for people allowed to open them.
- **Payroll figures:** only Board of Directors members, HR, Accounting and the System Administrator see payroll totals, and only company-wide. No dashboard shows individual pay (see [Sensitive data](../../SECURITY.md#sensitive-data)). The Board exception covers payroll run totals only, never per-employee pay.
- Any project cost figures in Insight follow the Pulse Ops [project cost](ops.md#project-costs) visibility rules, not the Board exception.

## Targets

- Board of Directors members with Insight Read and the System Administrator set a **yearly revenue target** and an **SLA compliance target** (default 95%), stored per year. This needs no Owner level (Insight has none). Sales quotas come from Pulse Engage.
- Dashboards show progress against each target.

## Data freshness

- Day-to-day figures are live.
- At each month-end close, a background job stores a **snapshot** of the key figures, so trends compare like with like and don't shift when old records are corrected.
- Snapshots store aggregates only, never per-employee pay or raw sensitive fields.
- Snapshots follow the same access rules as the live figures. Payroll totals in a snapshot are visible only to the Board of Directors, HR, Accounting and the System Administrator.

## Filters and exports

- Filters: date range, business line, product, client and department.
- Every dashboard exports as PDF and Excel.

## Weekly Board summary

- Every Monday at 8:00 AM (Asia/Manila), every Board of Directors member with Insight Read gets an in-app summary: the past week and the month to date against targets, plus notable items (deals won and lost, projects on hold, SLA breaches, overdue invoices) shown as counts and totals per category only, e.g. "3 deals won (₱4.2M), 2 projects on hold, 5 SLA breaches, 7 overdue invoices (₱1.1M)". Individual records are never listed in the summary.
- The summary links to the Insight dashboards. Opening any record from there follows normal module access and record visibility.
- It moves to email once the email system ships.
