# Runbook

What to check and do when something goes wrong in Xtreme Pulse. Each entry links to the rule behind it. Production-specific steps (server names, backup locations, contacts) are placeholders until hosting is decided (see [DEPLOYMENT.md](DEPLOYMENT.md#still-to-decide)).

**Contacts:** System Administrator: _to be filled in_ · HR: _to be filled in_ · Accounting: _to be filled in_

## Access

### A user can't sign in

1. Is their email on an allowed domain, typed in lowercase? (see [Sign-in and passwords](../SECURITY.md#sign-in-and-passwords))
2. Does a user account exist? There's no self-registration.
3. Is their employment status active? Resigned, Terminated and Retired accounts are deactivated (see [Account status](../SECURITY.md#account-status)).
4. Forgotten password: until the email reset ships, HR or the System Administrator sets a temporary password, which the user must change on sign-in. Only a System Administrator can reset a System Administrator's password.
5. Signed out unexpectedly: sessions last 24 hours, then everyone signs in again.

There is no lockout to clear. The app has no account lockout.

### A user can't see a module or a record

- **Module missing from the sidebar:** the user has None on it. HR or the System Administrator sets access on `/admin/access` (see [User access page](modules/core.md#user-access-page)).
- **"Only the deal team can open this deal"**, or the same for a project: this is record-level visibility, working as designed. Ask the owner or lead to add them to the team.
- **Sensitive fields masked or hidden:** module access never reveals them (see [Sensitive data](../SECURITY.md#sensitive-data)).

### Locked out of the only System Administrator account

Another System Administrator can reset the password. If there's no other, `pnpm seed:admin` won't help, because it skips creating an admin when one exists. Recovery needs direct database access. Decide the procedure in advance, and keep a second System Administrator account so this can't happen.

### The only System Administrator is disabled

Only another System Administrator can re-enable a System Administrator (see [Bootstrap System Administrator account](modules/core.md#bootstrap-system-administrator-account)). `pnpm seed:admin` won't create a new one, because it counts a disabled System Administrator as existing.

This is a known limitation. The spec defines no safe recovery yet: the procedure is to be defined in step 1.7, with disabling the system account. Don't edit the users collection by hand. Until then, keep at least two active System Administrator accounts.

## Payroll and HR

### A timesheet wasn't approved before the payroll run

This is expected. The employee still gets basic pay, and overtime, reimbursements and deductions settle in the next cut-off (see [Submission & approval](modules/talent.md#submission--approval)).

### A finalized payroll run has an error

Finalized runs are locked. Add a manual adjustment with a reason in the next draft run (see [Manual inputs & adjustments](modules/talent.md#manual-inputs--adjustments)).

### A holiday was added or moved late

Adding or changing a confirmed holiday recomputes the DTR for periods not yet finalized. Finalized periods are adjusted in the next payroll (see [Holiday calendar](modules/core.md#holiday-calendar)).

### The 100th hire of the year fails

Employee numbers allow at most 99 per year (see [Employee number](modules/core.md#employee-number-company-id)). Changing that is a spec change, not a fix.

## Money and stock

### A posted journal entry is wrong

Never edit or delete it. Post a reversal entry, then the correct one. If the month is closed, post both in the current open period (see [Ledger](DATA_MODEL.md#ledger-pulse-fiscal)).

### On-hand stock or a serial's location is wrong

On-hand stock is derived from movements, so find the missing or wrong movement and record a correcting one (transfer, return and so on). Never edit a quantity (see [Inventory](DATA_MODEL.md#inventory-pulse-supply)).

### A receipt was rejected as a duplicate

The same merchant TIN and receipt number can't be claimed twice, whether as a reimbursement or on a petty cash voucher. This is working as designed. Check who claimed it first (see [Reimbursements](modules/talent.md#reimbursements)).

## Background jobs

### Reminders, SLA alerts or summaries stopped

1. Is the worker process running, and can it reach Redis? In development, `/dev/health` shows this. Production needs its own check (see [DEPLOYMENT.md](DEPLOYMENT.md#still-to-decide)).
2. Is the server clock right, and are jobs scheduled on Asia/Manila time?
3. After a restart, check that jobs that should have run while it was down did run, for example that day's SLA breaches and renewals.

The list of jobs is in [Background jobs](ARCHITECTURE.md#background-jobs).

## Data and recovery

### Encryption key lost or changed

Encrypted sensitive fields (salaries, government IDs, bank accounts and so on) can't be read without `FIELD_ENCRYPTION_LOCAL_KEY`. Restore the original key from its safe copy. A new key won't decrypt old data. Never change the key without a planned rotation: the data keys in the `encryptionKeys` key vault must be re-wrapped with the new key while the old one is still available (the fields themselves don't need re-encrypting; see [ADR 0005](adr/0005-field-level-encryption.md) and [Secrets](../SECURITY.md#secrets)).

### Restore from backup

_To be written once backups are set up (see [DEPLOYMENT.md](DEPLOYMENT.md#still-to-decide))._ The procedure must cover MongoDB, the `storage/` folder and the encryption key together, and it must be tested before go-live.

### Files missing after a deploy

The deploy replaced or emptied `storage/`. Restore the folder from the latest backup. Then change the deploy so it leaves `storage/` in place, or point `FILE_STORAGE_DIR` at a folder outside the code (see [File storage](ARCHITECTURE.md#file-storage)).

### Seed script run again on production

This is safe. `pnpm seed:admin` skips an existing System Administrator and inserts only missing base data. It never overwrites records (see [Bootstrap System Administrator account](modules/core.md#bootstrap-system-administrator-account)).

## Local development

### Transactions fail: MongoDB is standalone

**Symptom:** on `/dev/health`, the Replica set row shows "None (standalone server)" and the Test transaction row shows "Not committed". `mongosh --eval "rs.status()"` fails with `NoReplicationEnabled`.

Transactions need a replica set. Convert the local MongoDB with the steps in [MongoDB replica set (once)](../README.md#mongodb-replica-set-once), then check that `MONGODB_URI` ends with `?replicaSet=rs0`.

### Redis or Memurai is down

**Symptom:** the worker logs an error with `connect ECONNREFUSED`, and `/dev/health` shows "Can’t reach Redis".

1. Check that the service is running: on Windows, `Get-Service Memurai`; on macOS, `brew services list`; on Linux, `systemctl status redis`.
2. Restart it: on Windows, `Restart-Service Memurai` in an administrator PowerShell; on macOS, `brew services restart redis`; on Linux, `sudo systemctl restart redis`.
3. Check that `REDIS_URL` in `.env.local` points to it, then restart `pnpm dev`.

The setup is in [Redis (once)](../README.md#redis-once).

### Encryption key invalid

**Symptom:** `/dev/health` shows "Field encryption key is invalid": "FIELD_ENCRYPTION_LOCAL_KEY must be 96 random bytes, base64-encoded (128 characters)."

- **Nothing has been encrypted yet** (a fresh local database): generate a new key as described in [Run the app](../README.md#run-the-app), put it in `.env.local`, and restart `pnpm dev`.
- **Encrypted data already exists:** don't generate a new key. It can't decrypt the old data. Restore the original key from its safe copy (see [Encryption key lost or changed](#encryption-key-lost-or-changed)).
