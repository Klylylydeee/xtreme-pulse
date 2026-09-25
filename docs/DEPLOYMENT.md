# Deployment

How Xtreme Pulse runs locally and in production, and how to go live. The production setup hasn't been decided yet, so those sections list what's needed and what's still open.

## Local development

The local stack runs in Docker (build step 0.1): a single-node MongoDB replica set and Redis. Uploaded and generated files are saved in the project's `storage/` folder (see [File storage](ARCHITECTURE.md#file-storage)). `pnpm dev` starts the app and the BullMQ worker. Setup steps are in [README.md › Getting started](../README.md#getting-started).

## Environment variables

| Variable | What it's for |
| --- | --- |
| `MONGODB_URI` | MongoDB connection string. It must point to a replica set, because transactions need one. The local Docker setup runs a single-node replica set. |
| `AUTH_SECRET` | Secret that Auth.js uses to sign and encrypt sessions. Generate a long random value, for example with `npx auth secret`. |
| `REDIS_URL` | Redis connection for the BullMQ background jobs. |
| `FILE_STORAGE_DIR` | Folder for uploaded and generated files. Default: `./storage` in the project. It must be outside `public/`, is never committed, and must survive deploys (see [File storage](ARCHITECTURE.md#file-storage)). |
| `SEED_ADMIN_EMAIL` | Login email of the bootstrap System Administrator, read by `pnpm seed:admin`. Default: `sysadmin@xtreme-works.com`. |
| `SEED_ADMIN_PASSWORD` | Initial password for that account, changed on first sign-in. Never commit it. |
| `FIELD_ENCRYPTION_LOCAL_KEY` | Master key that encrypts sensitive fields at rest: a random 96-byte value, base64-encoded. Use a new value on the real server and keep a safe copy, since encrypted fields can't be read without it. |

Put the values in `.env.local`, which is never committed. Phase 0 creates a `.env.example` that lists every variable without values.

## Production

Xtreme Pulse is hosted internally and reachable only on the office network or via VPN (see [Network exposure](../SECURITY.md#network-exposure)). Whatever hosting is chosen must provide:

| Needs | Why |
|---|---|
| MongoDB as a replica set | Transactions need one (see [ADR 0003](adr/0003-mongodb-replica-set.md)). The edition decides the field encryption mode (see [ADR 0005](adr/0005-field-level-encryption.md)) |
| Redis | BullMQ queues for reminders, timers and snapshots |
| A long-running worker process | Runs the [background jobs](ARCHITECTURE.md#background-jobs) alongside the web app |
| A persistent folder for `storage/` | 201 files, receipts, medical certificates, photos and generated PDFs. It must survive deploys and be backed up with the database |
| Node.js (current LTS) | Runs the Next.js app |
| SMTP (later phase) | Password reset and email notifications |

### Still to decide

- [ ] Where it runs: an on-premises server or a private cloud reachable only through the VPN
- [ ] The internal URL, and a TLS certificate for it
- [ ] How releases are built and deployed (manual or CI), and how to roll one back
- [ ] Backups of the database and the `storage/` folder: how often, where they're stored, how long they're kept, and a tested restore (see [Runbook](RUNBOOK.md#restore-from-backup))
- [ ] Disk encryption on the server, since `storage/` holds medical certificates and 201 files
- [ ] Where the encryption master key is kept, with an offline copy (see [Secrets](../SECURITY.md#secrets))
- [ ] Monitoring: how you learn that the app, the worker, or a scheduled job has stopped

Record each decision here, and in an ADR if it's architectural.

## Going live

Go live in stages if you like, for example Core and Talent after Phase 2. Each stage uses the steps below for the modules it includes. This list assumes the server and database are already set up.

1. **Create the System Administrator.** Set `SEED_ADMIN_EMAIL` (sysadmin@xtreme-works.com) and `SEED_ADMIN_PASSWORD` in the server environment, never in the repo, then run `pnpm seed:admin` on the real database. Sign in, change the password, and remove `SEED_ADMIN_PASSWORD` from the environment. At each later stage, run pnpm seed:admin again; it skips the existing System Administrator and adds only the new modules' missing base data.
   - Done when: you sign in with your new password, and the seeded departments, positions, leave types and rates are there.
2. **Fill in the company details.** In company settings, enter the logo, registered name, business address, TIN and RDO code, SSS, PhilHealth and Pag-IBIG employer numbers, and BIR registration details. Until then, documents show placeholders such as `[Company TIN]`.
   - Done when: generated PDFs show the real details, and only the BIR registration details may wait (see BIR registration below).
3. **Check the seeded rates.** Check each seeded rate against its latest official issuance. This covers the SSS, PhilHealth and Pag-IBIG tables, BIR withholding table, NCR minimum wage, holiday premiums, de minimis limits and 13th month ceiling. Enter any change as a new effective-dated version; with Fiscal, also check the VAT rate, ATC codes and EWT rates.
   - Done when: every rate table's latest version matches its official issuance and effective date.
4. **Confirm the holiday calendar.** HR drafts this year's holidays, by running the auto-draft job once for the current year or by hand. HR checks each against the Presidential Proclamation in the Official Gazette, adds any missing, and confirms them, since only confirmed holidays affect attendance, leave and payroll.
   - Done when: every holiday this year is confirmed with its legal basis, and no drafts are left.
5. **Set up the people.** Create HR's account first and give it access; HR then adds every employee, typing existing company IDs so the counter is raised. Set department heads and `reportingTo`, then module access on the User access page, including Insight Read for Board members. Everyone completes onboarding, and HR verifies government IDs and bank details before the first payroll. HR then enters each employee's opening VL, SL and offset balances and year-to-date pay as of the go-live date.
   - Done when: the org chart shows everyone under the right supervisors, every user has access set and onboarding complete, and every employee has opening entries.
6. **Run the first payroll in parallel.** For one cut-off, everyone files timesheets in Pulse while HR also runs payroll the current way. Compare every payslip, and rely on Pulse only once the results match.
   - Done when: every employee's gross pay, contributions, withholding tax and net pay match, or each difference is explained and fixed.
7. **Move the books to Pulse Fiscal.** When Fiscal is included, fill the import templates with opening balances, open invoices, open bills and bank balances as of the go-live date. Import them; the import must balance and agree with the AR and AP control accounts. Then close the Excel books at that date.
   - Done when: the import is accepted, the trial balance matches the closed Excel books, and nothing new is recorded in Excel.
8. **BIR registration.** Apply early for the CAS/CBA acknowledgment or permit; Pulse must not issue invoices or keep computerized books until you have it. Then enter the registration details in company settings and set the invoice series to the registered one.
   - Done when: company settings holds the BIR details, and the next invoice number follows the registered series.
9. **Brief the team.** Walk technicians and drivers through the phone flows: timesheets, daily site reports, delivery receipts and service reports. Show supervisors their approvals, and the Board payroll run and PO approvals, payment approvals (Managing Director and Sales Director) and Insight.
   - Done when: each technician and driver has submitted a timesheet from their phone, and each approver has acted on a real request.
