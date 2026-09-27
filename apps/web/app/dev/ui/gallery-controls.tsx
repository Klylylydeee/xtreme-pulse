'use client';

import { useRef, useState, type FormEvent } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { FormField, FormSection, Input, Select, Switch, Textarea } from '@pulse/ui/components/form';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTrigger,
} from '@pulse/ui/components/sheet';
import {
  ShortcutHint,
  ariaKeyShortcuts,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';

const SUBMIT = ['mod', 'enter'] as const;

/** Waits, to show loading states. */
function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ButtonsDemo() {
  const [loading, setLoading] = useState(false);
  return (
    <div className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card">
      <div className="flex flex-wrap gap-3">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="tinted">Tinted</Button>
        <Button variant="plain">Plain</Button>
        <Button variant="destructive">Delete draft</Button>
        <Button variant="plain" size="icon" aria-label="Edit">
          <Pencil aria-hidden="true" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button
          loading={loading}
          onClick={async () => {
            setLoading(true);
            await wait(1500);
            setLoading(false);
          }}
        >
          {loading ? 'Saving…' : 'Save (shows loading)'}
        </Button>
        <Button disabled>Disabled</Button>
        <Button variant="secondary" disabled>
          Disabled
        </Button>
        <Button variant="destructive" disabled>
          Disabled
        </Button>
      </div>
    </div>
  );
}

export function ShortcutHintsDemo() {
  const [count, setCount] = useState(0);
  useShortcut(SUBMIT, () => setCount((value) => value + 1));
  return (
    <div className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          aria-keyshortcuts={ariaKeyShortcuts(SUBMIT)}
          onClick={() => setCount((value) => value + 1)}
          className="pr-3"
        >
          Submit timesheet
          <ShortcutHint keys={SUBMIT} tone="on-fill" />
        </Button>
        <Button variant="secondary" aria-keyshortcuts="Escape" className="pr-3">
          Cancel
          <ShortcutHint keys={['escape']} />
        </Button>
        <Button variant="destructive" className="pr-3">
          Void invoice
          <ShortcutHint keys={['mod', 'shift', 'enter']} tone="on-fill" />
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-subheadline">
        <dt className="text-text-secondary">Search or jump to</dt>
        <dd>
          <ShortcutHint keys={['mod', 'k']} announce />
        </dd>
        <dt className="text-text-secondary">Save</dt>
        <dd>
          <ShortcutHint keys={['mod', 's']} announce />
        </dd>
      </dl>
      <p className="text-footnote text-text-secondary" aria-live="polite">
        Press ⌘↵ / Ctrl+Enter anywhere on this page, or the button: submitted {count} times.
      </p>
    </div>
  );
}

const ACCESS_LEVELS = [
  { value: 'none', label: 'None' },
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Write' },
  { value: 'owner', label: 'Owner' },
] as const;

type AccessLevel = (typeof ACCESS_LEVELS)[number]['value'];

const ACCESS_DESCRIPTIONS: Record<AccessLevel, string> = {
  none: 'No access to this module.',
  read: 'Can view records.',
  write: 'Can create and edit records.',
  owner: 'Can also approve, delete and manage settings.',
};

export function SegmentedControlDemo() {
  const [view, setView] = useState<'daily' | 'reimbursements'>('daily');
  const [access, setAccess] = useState<AccessLevel>('read');
  const [period, setPeriod] = useState<'week' | 'cutoff' | 'month'>('cutoff');
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-footnote text-text-secondary">Switching views, on the page</p>
        <SegmentedControl
          label="Timesheet view"
          track="page"
          value={view}
          onValueChange={setView}
          options={[
            { value: 'daily', label: 'Daily entries' },
            {
              value: 'reimbursements',
              ariaLabel: 'Reimbursements, 2',
              label: (
                <>
                  Reimbursements
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-bg-grouped px-1.5 text-caption font-semibold text-text-secondary numeric">
                    2
                  </span>
                </>
              ),
            },
          ]}
        />
      </div>
      <div className="flex flex-col gap-2 rounded-card bg-surface p-4 shadow-card">
        <p className="text-footnote text-text-secondary">Access picker, on a surface</p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-subheadline font-semibold">Pulse Engage</span>
            <span className="text-footnote text-text-secondary" aria-live="polite">
              {ACCESS_DESCRIPTIONS[access]}
            </span>
          </div>
          <SegmentedControl
            label="Engage access"
            tone="accent"
            value={access}
            onValueChange={setAccess}
            options={ACCESS_LEVELS}
          />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <span className="text-subheadline font-semibold">Pulse Insight</span>
            <span className="text-footnote text-text-secondary">
              Locked by the System Administrator switch.
            </span>
          </div>
          <SegmentedControl
            label="Insight access"
            tone="accent"
            value="read"
            onValueChange={() => {}}
            disabled
            options={[
              { value: 'none', label: 'None' },
              { value: 'read', label: 'Read' },
            ]}
          />
        </div>
      </div>
      <div className="flex max-w-md flex-col gap-2">
        <p className="text-footnote text-text-secondary">Full width, with a disabled segment</p>
        <SegmentedControl
          label="Period"
          track="page"
          fullWidth
          value={period}
          onValueChange={setPeriod}
          options={[
            { value: 'week', label: 'Week' },
            { value: 'cutoff', label: 'Cut-off' },
            { value: 'month', label: 'Month', disabled: true },
          ]}
        />
      </div>
    </div>
  );
}

type LeaveErrors = Partial<Record<'type' | 'start' | 'end' | 'reason', string>>;

function validateLeave(form: FormData): LeaveErrors {
  const errors: LeaveErrors = {};
  const start = String(form.get('start') ?? '');
  const end = String(form.get('end') ?? '');
  if (!form.get('type')) errors.type = 'Choose a leave type.';
  if (!start) errors.start = 'Enter the first day of leave.';
  if (!end) errors.end = 'Enter the last day of leave.';
  else if (start && end < start) errors.end = 'The last day can’t be before the first day.';
  if (String(form.get('reason') ?? '').trim().length < 5)
    errors.reason = 'Add a short reason (at least 5 characters).';
  return errors;
}

/** A create flow in a sheet: inset grouped sections, inline validation and ⌘↵ / Ctrl+Enter to submit. */
export function SheetFormDemo() {
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<LeaveErrors>({});
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useShortcut(SUBMIT, () => submitFormFromShortcut(formRef.current), {
    enabled: open,
    scope: formRef,
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const found = validateLeave(new FormData(event.currentTarget));
    setErrors(found);
    const first = Object.keys(found)[0];
    if (first) {
      // Move focus to the first field with an error.
      event.currentTarget.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    setPending(true);
    await wait(900);
    setPending(false);
    setSubmitted('Leave request submitted.');
    setOpen(false);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Sheet
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (next) {
              setErrors({});
              setSubmitted(null);
            }
          }}
        >
          <SheetTrigger asChild>
            <Button>
              <Plus aria-hidden="true" className="size-5" />
              New leave request
            </Button>
          </SheetTrigger>
          <SheetContent aria-describedby={undefined}>
            <form
              ref={formRef}
              noValidate
              onSubmit={submit}
              className="flex min-h-0 flex-1 flex-col"
            >
              <SheetHeader title="New leave request" />
              <SheetBody>
                <FormSection
                  title="Leave"
                  footer="Holidays aren’t deducted from your leave balance."
                >
                  <FormField label="Leave type" required error={errors.type}>
                    <Select name="type" defaultValue="">
                      <option value="" disabled>
                        Choose…
                      </option>
                      <option value="vl">Vacation leave</option>
                      <option value="sl">Sick leave</option>
                    </Select>
                  </FormField>
                  <FormField label="First day" required error={errors.start}>
                    <Input name="start" type="date" />
                  </FormField>
                  <FormField label="Last day" required error={errors.end}>
                    <Input name="end" type="date" />
                  </FormField>
                  <FormField label="Half day" layout="inline">
                    <Switch name="halfDay" />
                  </FormField>
                </FormSection>
                <FormSection title="Details">
                  <FormField
                    label="Reason"
                    required
                    hint="Your supervisor sees this."
                    error={errors.reason}
                  >
                    <Textarea name="reason" />
                  </FormField>
                </FormSection>
              </SheetBody>
              <SheetFooter>
                <SheetClose asChild>
                  <Button variant="secondary" className="pr-3">
                    Cancel
                    <ShortcutHint keys={['escape']} />
                  </Button>
                </SheetClose>
                <Button
                  type="submit"
                  loading={pending}
                  aria-keyshortcuts={ariaKeyShortcuts(SUBMIT)}
                  className="pr-3"
                >
                  Submit request
                  <ShortcutHint keys={SUBMIT} tone="on-fill" />
                </Button>
              </SheetFooter>
            </form>
          </SheetContent>
        </Sheet>
      </div>
      <p className="text-footnote text-success-text" role="status">
        {submitted}
      </p>
    </div>
  );
}

/** Inset grouped sections with every field state, outside a sheet. */
export function FormStatesDemo() {
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const nameError = touched && name.trim() === '' ? 'Enter the employee’s name.' : undefined;
  return (
    <div className="grid max-w-3xl gap-6 md:grid-cols-2">
      <FormSection title="Contact" footer="Validated when you leave the field.">
        <FormField label="Full name" required error={nameError}>
          <Input
            name="fullName"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="Juan dela Cruz"
            autoComplete="off"
          />
        </FormField>
        <FormField label="Work email" hint="Only the company’s email domains are allowed.">
          <Input type="email" placeholder="name@company" autoComplete="off" />
        </FormField>
      </FormSection>
      <FormSection title="States">
        <FormField label="With an error" error="This field has an error.">
          <Input defaultValue="Invalid value" />
        </FormField>
        <FormField label="Disabled">
          <Input disabled defaultValue="Can’t be changed" />
        </FormField>
        <FormField label="Email notifications" layout="inline">
          <Switch defaultChecked />
        </FormField>
        <FormField label="Disabled switch" layout="inline">
          <Switch disabled />
        </FormField>
      </FormSection>
    </div>
  );
}

export function ConfirmDialogDemo() {
  const [deleted, setDeleted] = useState(false);
  const [voidError, setVoidError] = useState<string | undefined>();
  return (
    <div className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card">
      <div className="flex flex-wrap gap-3">
        <DestructiveConfirmDialog
          trigger={
            <Button variant="destructive">
              <Trash2 aria-hidden="true" className="size-4.5" />
              Delete draft
            </Button>
          }
          title="Delete this draft timesheet?"
          description="The entries for Sep 11 – 25 are removed. This can’t be undone."
          confirmLabel="Delete draft"
          onConfirm={async () => {
            await wait(900);
            setDeleted(true);
          }}
        />
        <DestructiveConfirmDialog
          trigger={<Button variant="secondary">Void invoice (fails)</Button>}
          onOpenChange={(open) => {
            if (open) setVoidError(undefined);
          }}
          title="Void invoice INV-2026-0042?"
          description="A voided invoice stays in the records, marked void."
          confirmLabel="Void invoice"
          error={voidError}
          onConfirm={async () => {
            await wait(700);
            setVoidError('The invoice couldn’t be voided. Try again.');
            throw new Error('demo failure');
          }}
        />
      </div>
      <p className="text-footnote text-text-secondary" role="status">
        {deleted ? 'Draft deleted.' : 'Nothing deleted yet.'}
      </p>
    </div>
  );
}
