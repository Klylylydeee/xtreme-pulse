'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, CircleCheck, Plus } from 'lucide-react';
import { DEPARTMENT_CODE_HELP, DEPARTMENT_NAME_MAX_LENGTH, formatDate } from '@pulse/core';
import type { DepartmentView } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { FormField, FormSection, Input } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetFooter,
  SheetHeader,
} from '@pulse/ui/components/sheet';
import {
  ariaKeyShortcuts,
  ShortcutHint,
  submitFormFromShortcut,
  useShortcut,
} from '@pulse/ui/components/shortcut-hint';
import { useReturnFocus } from '@pulse/ui/hooks/use-return-focus';
import { FormAlert } from '@/components/form-alert';
import {
  Badge,
  plural,
  ReadOnlyField,
  ShowRetiredSwitch,
  useActionSubmit,
} from '@/components/org-structure';
import {
  createDepartmentAction,
  restoreDepartmentAction,
  retireDepartmentAction,
  updateDepartmentAction,
} from '@/lib/actions/org-structure';
import { DepartmentHeadPicker, type PickedHead } from './department-head-picker';

// Spec: docs/modules/core.md#managing-departments-and-positions — the departments list. A row opens
// its sheet: the edit form for a live department (name and head; the code is fixed), or its details
// and Restore for a retired one. Retiring asks first, and is refused while the department still has
// live positions or active employees.

const SUBMIT = ['mod', 'enter'] as const;

const column = createDataTableColumns<DepartmentView>();

const COLUMNS: DataTableColumn<DepartmentView>[] = column.columns([
  column.accessor('name', {
    header: 'Name',
    sortFn: 'text',
    cell: (info) => (
      <span className="flex min-w-40 items-center gap-2">
        <span className="font-medium">{info.getValue()}</span>
        {info.row.original.retiredAt ? <Badge>Retired</Badge> : null}
      </span>
    ),
  }),
  column.accessor('code', {
    header: 'Code',
    sortFn: 'text',
    cell: (info) => <span className="font-medium tracking-wide">{info.getValue()}</span>,
    meta: { width: '8rem' },
  }),
  column.accessor((department) => department.headName ?? '', {
    id: 'head',
    header: 'Head',
    sortFn: 'text',
    cell: (info) =>
      info.getValue() ? (
        <span className="whitespace-nowrap">{info.getValue()}</span>
      ) : (
        <span className="text-text-secondary">No head</span>
      ),
  }),
  column.accessor('positionCount', {
    header: 'Positions',
    sortFn: 'basic',
    meta: { align: 'end', width: '8rem' },
  }),
  column.accessor('activeEmployeeCount', {
    header: 'Employees',
    sortFn: 'basic',
    meta: { align: 'end', width: '8rem' },
  }),
]);

function DepartmentPhoneRow({ department }: { department: DepartmentView }) {
  return (
    <>
      <IconTile className="size-11 rounded-xl [&_svg]:size-5">
        <Building2 strokeWidth={1.75} />
      </IconTile>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-subheadline font-semibold">{department.name}</span>
          {department.retiredAt ? <Badge>Retired</Badge> : null}
        </span>
        <span className="truncate text-footnote text-text-secondary">
          <span className="font-medium tracking-wide">{department.code}</span>
          {' · '}
          {department.headName ?? 'No head'}
        </span>
        <span className="text-footnote text-text-secondary numeric">
          {plural(department.positionCount, 'position', 'positions')} ·{' '}
          {plural(department.activeEmployeeCount, 'employee', 'employees')}
        </span>
      </span>
    </>
  );
}

export function DepartmentsManager({
  departments,
  showRetired,
}: {
  departments: DepartmentView[];
  showRetired: boolean;
}) {
  const router = useRouter();
  const returnFocus = useReturnFocus();
  const [open, setOpen] = useState(false);
  // Kept while the sheet closes, so its content doesn't change during the animation.
  const [target, setTarget] = useState<DepartmentView | null>(null);
  // A new form (fresh fields and errors) every time the sheet opens.
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  function openSheet(department: DepartmentView | null, trigger?: HTMLElement | null) {
    returnFocus.remember(trigger);
    setTarget(department);
    setSession((count) => count + 1);
    setNotice(null);
    setOpen(true);
  }

  function finished(message: string) {
    setOpen(false);
    setNotice(message);
    router.refresh();
  }

  const retiredCount = departments.filter((department) => department.retiredAt).length;
  const liveCount = departments.length - retiredCount;

  return (
    <>
      <PageHeader
        title="Departments"
        description="The company’s departments, their codes and heads. Positions belong to a department."
        actions={
          <Button onClick={(event) => openSheet(null, event.currentTarget)}>
            <Plus aria-hidden="true" className="size-5" />
            Add department
          </Button>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p role="status" className="text-footnote text-text-secondary">
          {notice ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-success-text">
              <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
              {notice}
            </span>
          ) : (
            <span className="numeric">
              {plural(liveCount, 'department', 'departments')}
              {showRetired ? `, ${retiredCount} retired` : null}
            </span>
          )}
        </p>
        <ShowRetiredSwitch checked={showRetired} />
      </div>
      {departments.length === 0 ? (
        <EmptyState
          icon={<Building2 strokeWidth={1.75} />}
          title="No departments yet"
          description="Add the company’s departments, then the positions in each one."
          action={
            <Button variant="tinted" onClick={(event) => openSheet(null, event.currentTarget)}>
              <Plus aria-hidden="true" className="size-5" />
              Add department
            </Button>
          }
        />
      ) : (
        <DataTable
          caption="Departments"
          captionHidden
          columns={COLUMNS}
          data={departments}
          getRowId={(department) => department.id}
          initialSorting={[{ id: 'name', desc: false }]}
          selectedRowId={open ? target?.id : null}
          rowActionLabel={(department) =>
            department.retiredAt ? `Details for ${department.name}` : `Edit ${department.name}`
          }
          onRowSelect={(department, element) => openSheet(department, element)}
          renderPhoneRow={(department) => <DepartmentPhoneRow department={department} />}
        />
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent aria-describedby={undefined} onCloseAutoFocus={returnFocus.onCloseAutoFocus}>
          {target?.retiredAt ? (
            <RetiredDepartment
              key={session}
              department={target}
              onRestored={() => finished(`${target.name} restored.`)}
            />
          ) : (
            <DepartmentForm
              key={session}
              department={target}
              onSaved={(name) => finished(target ? `${name} saved.` : `${name} added.`)}
              onRetired={(name) => finished(`${name} retired.`)}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Add or edit: name, code (fixed once added) and head. */
function DepartmentForm({
  department,
  onSaved,
  onRetired,
}: {
  department: DepartmentView | null;
  onSaved: (name: string) => void;
  onRetired: (name: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef('');
  const [head, setHead] = useState<PickedHead | null>(
    department?.headEmployeeId
      ? { id: department.headEmployeeId, name: department.headName ?? 'Unknown employee' }
      : null,
  );
  const save = useActionSubmit<unknown>(
    department ? updateDepartmentAction : createDepartmentAction,
    () => onSaved(nameRef.current),
  );

  useShortcut(SUBMIT, () => submitFormFromShortcut(formRef.current), { scope: formRef });

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={(event) => {
        nameRef.current = String(new FormData(event.currentTarget).get('name') ?? '').trim();
        void save.onSubmit(event);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <SheetHeader
        title={department ? department.name : 'Add department'}
        leading={
          <IconTile className="size-11 rounded-xl [&_svg]:size-5">
            <Building2 strokeWidth={1.75} />
          </IconTile>
        }
      />
      <SheetBody>
        {department ? <input type="hidden" name="id" value={department.id} /> : null}
        <FormAlert message={save.formError} />
        <FormSection title="Department">
          <FormField label="Name" required error={save.fieldErrors.name}>
            <Input
              name="name"
              defaultValue={department?.name ?? ''}
              maxLength={DEPARTMENT_NAME_MAX_LENGTH}
              autoComplete="off"
              autoFocus={!department}
              required
            />
          </FormField>
          {department ? (
            <ReadOnlyField label="Code" hint="A department’s code can’t be changed.">
              <span className="font-medium tracking-wide text-text-primary">{department.code}</span>
            </ReadOnlyField>
          ) : (
            <FormField
              label="Code"
              required
              hint={`${DEPARTMENT_CODE_HELP} It can’t be changed later, or reused.`}
              error={save.fieldErrors.code}
            >
              <Input
                name="code"
                maxLength={10}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                className="uppercase"
                required
              />
            </FormField>
          )}
        </FormSection>
        <FormSection
          title="Head"
          footer="Optional. Any employee with an active account, from any department."
        >
          <FormField label="Department head" error={save.fieldErrors.headEmployeeId}>
            <DepartmentHeadPicker value={head} onChange={setHead} />
          </FormField>
        </FormSection>
        {department ? (
          <FormSection title="In this department">
            <ReadOnlyField label="Live positions">
              <span className="numeric">{department.positionCount}</span>
            </ReadOnlyField>
            <ReadOnlyField label="Active employees">
              <span className="numeric">{department.activeEmployeeCount}</span>
            </ReadOnlyField>
          </FormSection>
        ) : null}
      </SheetBody>
      <SheetFooter>
        {department ? (
          <RetireDepartmentButton department={department} onRetired={onRetired} />
        ) : null}
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Cancel
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        <Button
          type="submit"
          loading={save.pending}
          aria-keyshortcuts={ariaKeyShortcuts(SUBMIT)}
          className="pr-3"
        >
          {department ? 'Save' : 'Add department'}
          <ShortcutHint keys={SUBMIT} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Retire, after the destructive confirmation. A refused retire is shown in the dialog. */
function RetireDepartmentButton({
  department,
  onRetired,
}: {
  department: DepartmentView;
  onRetired: (name: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const retire = useActionSubmit(retireDepartmentAction, () => onRetired(department.name));

  return (
    <>
      <Button
        variant="plain"
        onClick={() => {
          retire.reset();
          setConfirming(true);
        }}
        className="mr-auto text-destructive-text hover:bg-bg-grouped hover:text-destructive-text"
      >
        Retire
      </Button>
      <DestructiveConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Retire ${department.name}?`}
        description="It can’t be picked for new positions or employees, and its code stays reserved. You can restore it later from “Show retired”."
        confirmLabel="Retire department"
        error={retire.formError}
        onConfirm={async () => {
          const ok = await retire.run({ id: department.id });
          // Keeps the dialog open, showing why, when the retire was refused.
          if (!ok) throw new Error('Retire refused');
        }}
      />
    </>
  );
}

/** A retired department: its details, and Restore. */
function RetiredDepartment({
  department,
  onRestored,
}: {
  department: DepartmentView;
  onRestored: () => void;
}) {
  const restore = useActionSubmit(restoreDepartmentAction, onRestored);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader
        title={department.name}
        leading={
          <IconTile className="size-11 rounded-xl [&_svg]:size-5">
            <Building2 strokeWidth={1.75} />
          </IconTile>
        }
      />
      <SheetBody>
        <FormAlert message={restore.formError} />
        <FormSection
          title="Department"
          footer={
            department.retiredAt
              ? `Retired on ${formatDate(department.retiredAt)}. Restore it to edit it or pick it again.`
              : undefined
          }
        >
          <ReadOnlyField label="Name">{department.name}</ReadOnlyField>
          <ReadOnlyField label="Code">
            <span className="font-medium tracking-wide">{department.code}</span>
          </ReadOnlyField>
          <ReadOnlyField label="Department head">{department.headName ?? 'No head'}</ReadOnlyField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Close
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        <Button loading={restore.pending} onClick={() => void restore.run({ id: department.id })}>
          Restore department
        </Button>
      </SheetFooter>
    </div>
  );
}
