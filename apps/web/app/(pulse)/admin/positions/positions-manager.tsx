'use client';

import { useId, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BriefcaseBusiness, Building2, CircleCheck, Plus } from 'lucide-react';
import {
  formatDate,
  POSITION_NAME_MAX_LENGTH,
  TIMESHEET_TYPE_CHANGE_NOTE,
  TIMESHEET_TYPE_LABELS,
  TIMESHEET_TYPE_OPTIONS,
} from '@pulse/core';
import type { PositionView } from '@pulse/core/server';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import {
  createDataTableColumns,
  DataTable,
  type DataTableColumn,
} from '@pulse/ui/components/data-table';
import { EmptyState } from '@pulse/ui/components/empty-state';
import { FormField, FormSection, Input, Select } from '@pulse/ui/components/form';
import { IconTile } from '@pulse/ui/components/icon-tile';
import { PageHeader } from '@pulse/ui/components/page-header';
import { SegmentedControl } from '@pulse/ui/components/segmented-control';
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
  createPositionAction,
  restorePositionAction,
  retirePositionAction,
  updatePositionAction,
} from '@/lib/actions/org-structure';

// Spec: docs/modules/core.md#managing-departments-and-positions — the positions list, filtered by
// department. A row opens its sheet: the edit form for a live position (name and timesheet type;
// the department is fixed), or its details and Restore for a retired one. Retiring asks first, and
// is refused while active employees hold the position.

/** A department in the filter and the add form. */
export interface DepartmentOption {
  id: string;
  name: string;
  code: string;
  retired: boolean;
}

type TimesheetType = (typeof TIMESHEET_TYPE_OPTIONS)[number];

const SUBMIT = ['mod', 'enter'] as const;

const TIMESHEET_SEGMENTS = TIMESHEET_TYPE_OPTIONS.map((value) => ({
  value,
  label: TIMESHEET_TYPE_LABELS[value],
}));

function TimesheetBadge({ type }: { type: TimesheetType }) {
  return (
    <Badge tone={type === 'overtime' ? 'accent' : 'neutral'}>{TIMESHEET_TYPE_LABELS[type]}</Badge>
  );
}

function departmentLabel(position: PositionView): string {
  return position.departmentName ?? 'Unknown department';
}

const column = createDataTableColumns<PositionView>();

const COLUMNS: DataTableColumn<PositionView>[] = column.columns([
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
  column.accessor((position) => departmentLabel(position), {
    id: 'department',
    header: 'Department',
    sortFn: 'text',
    cell: (info) => (
      <span className="flex min-w-40 items-center gap-2">
        <span className="flex flex-col">
          <span className="whitespace-nowrap">{info.getValue()}</span>
          {info.row.original.departmentCode ? (
            <span className="text-footnote font-medium tracking-wide text-text-secondary">
              {info.row.original.departmentCode}
            </span>
          ) : null}
        </span>
        {info.row.original.departmentRetired ? <Badge>Retired</Badge> : null}
      </span>
    ),
  }),
  column.accessor('timesheetType', {
    header: 'Timesheet type',
    sortFn: 'text',
    cell: (info) => <TimesheetBadge type={info.getValue()} />,
    meta: { width: '10rem' },
  }),
  column.accessor('activeEmployeeCount', {
    header: 'Employees',
    sortFn: 'basic',
    meta: { align: 'end', width: '8rem' },
  }),
]);

function PositionPhoneRow({ position }: { position: PositionView }) {
  return (
    <>
      <IconTile className="size-11 rounded-xl [&_svg]:size-5">
        <BriefcaseBusiness strokeWidth={1.75} />
      </IconTile>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-subheadline font-semibold">{position.name}</span>
          {position.retiredAt ? <Badge>Retired</Badge> : null}
        </span>
        <span className="truncate text-footnote text-text-secondary">
          {departmentLabel(position)}
          {position.departmentRetired ? ' (retired)' : null}
        </span>
        <span className="flex items-center gap-2 text-footnote text-text-secondary">
          <TimesheetBadge type={position.timesheetType} />
          <span className="numeric">
            {plural(position.activeEmployeeCount, 'employee', 'employees')}
          </span>
        </span>
      </span>
    </>
  );
}

export function PositionsManager({
  positions,
  departments,
  departmentId,
  showRetired,
}: {
  positions: PositionView[];
  departments: DepartmentOption[];
  /** The department filter, from the URL. */
  departmentId: string | null;
  showRetired: boolean;
}) {
  const router = useRouter();
  const returnFocus = useReturnFocus();
  const [open, setOpen] = useState(false);
  // Kept while the sheet closes, so its content doesn't change during the animation.
  const [target, setTarget] = useState<PositionView | null>(null);
  // A new form (fresh fields and errors) every time the sheet opens.
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [filtering, startFiltering] = useTransition();
  const filterId = useId();

  const liveDepartments = departments.filter((department) => !department.retired);
  const filterDepartment = departmentId
    ? (departments.find((department) => department.id === departmentId) ?? null)
    : null;
  // The filter lists live departments, and retired ones while they are shown (or picked).
  const filterOptions = departments.filter(
    (department) => !department.retired || showRetired || department.id === departmentId,
  );
  const canAdd = liveDepartments.length > 0;

  function openSheet(position: PositionView | null, trigger?: HTMLElement | null) {
    returnFocus.remember(trigger);
    setTarget(position);
    setSession((count) => count + 1);
    setNotice(null);
    setOpen(true);
  }

  function finished(message: string) {
    setOpen(false);
    setNotice(message);
    router.refresh();
  }

  function filterBy(id: string) {
    const params = new URLSearchParams(window.location.search);
    if (id) params.set('department', id);
    else params.delete('department');
    const query = params.toString();
    startFiltering(() => {
      router.replace(`/admin/positions${query ? `?${query}` : ''}`, { scroll: false });
    });
  }

  const retiredCount = positions.filter((position) => position.retiredAt).length;
  const liveCount = positions.length - retiredCount;
  const addButton = (variant: 'primary' | 'tinted') => (
    <Button
      variant={variant}
      disabled={!canAdd}
      onClick={(event) => openSheet(null, event.currentTarget)}
    >
      <Plus aria-hidden="true" className="size-5" />
      Add position
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Positions"
        description="The positions in each department, and the timesheet each one fills in."
        actions={canAdd ? addButton('primary') : undefined}
      />
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="flex w-full flex-col gap-1.5 sm:w-72">
            <label htmlFor={filterId} className="text-footnote font-semibold text-text-secondary">
              Department
            </label>
            <Select
              id={filterId}
              value={departmentId ?? ''}
              onChange={(event) => filterBy(event.target.value)}
              disabled={filtering}
              aria-busy={filtering || undefined}
            >
              <option value="">All departments</option>
              {filterDepartment === null && departmentId ? (
                <option value={departmentId}>Unknown department</option>
              ) : null}
              {filterOptions.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name} ({department.code}){department.retired ? ', retired' : ''}
                </option>
              ))}
            </Select>
          </div>
          <ShowRetiredSwitch checked={showRetired} />
        </div>
        <p role="status" className="text-footnote text-text-secondary">
          {notice ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-success-text">
              <CircleCheck aria-hidden="true" className="size-4 shrink-0" />
              {notice}
            </span>
          ) : (
            <span className="numeric">
              {plural(liveCount, 'position', 'positions')}
              {showRetired ? `, ${retiredCount} retired` : null}
            </span>
          )}
        </p>
      </div>
      {positions.length > 0 ? (
        <DataTable
          caption="Positions"
          captionHidden
          columns={COLUMNS}
          data={positions}
          getRowId={(position) => position.id}
          initialSorting={[{ id: 'name', desc: false }]}
          selectedRowId={open ? target?.id : null}
          rowActionLabel={(position) =>
            position.retiredAt ? `Details for ${position.name}` : `Edit ${position.name}`
          }
          onRowSelect={(position, element) => openSheet(position, element)}
          renderPhoneRow={(position) => <PositionPhoneRow position={position} />}
        />
      ) : !canAdd && !departmentId ? (
        <EmptyState
          icon={<Building2 strokeWidth={1.75} />}
          title="Add a department first"
          description="Every position belongs to a department. Add the departments, then come back to add their positions."
          action={
            <Button asChild variant="tinted">
              <Link href="/admin/departments">Go to departments</Link>
            </Button>
          }
        />
      ) : departmentId ? (
        <EmptyState
          icon={<BriefcaseBusiness strokeWidth={1.75} />}
          title={
            filterDepartment
              ? `No positions in ${filterDepartment.name}`
              : 'No positions in this department'
          }
          description={
            filterDepartment && !filterDepartment.retired
              ? 'Add one with “Add position”, or show all departments.'
              : 'Show all departments to see the other positions.'
          }
          action={
            <Button variant="tinted" onClick={() => filterBy('')}>
              Show all departments
            </Button>
          }
        />
      ) : (
        <EmptyState
          icon={<BriefcaseBusiness strokeWidth={1.75} />}
          title="No positions yet"
          description="Add the positions in each department, and choose the timesheet each one fills in."
          action={addButton('tinted')}
        />
      )}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent aria-describedby={undefined} onCloseAutoFocus={returnFocus.onCloseAutoFocus}>
          {target?.retiredAt ? (
            <RetiredPosition
              key={session}
              position={target}
              onRestored={() => finished(`${target.name} restored.`)}
            />
          ) : (
            <PositionForm
              key={session}
              position={target}
              departments={liveDepartments}
              defaultDepartmentId={
                filterDepartment && !filterDepartment.retired ? filterDepartment.id : ''
              }
              onSaved={(name) => finished(target ? `${name} saved.` : `${name} added.`)}
              onRetired={(name) => finished(`${name} retired.`)}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Add or edit: name, department (fixed once added) and timesheet type. */
function PositionForm({
  position,
  departments,
  defaultDepartmentId,
  onSaved,
  onRetired,
}: {
  position: PositionView | null;
  /** Live departments, for a new position. */
  departments: DepartmentOption[];
  defaultDepartmentId: string;
  onSaved: (name: string) => void;
  onRetired: (name: string) => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const nameRef = useRef('');
  const [timesheetType, setTimesheetType] = useState<TimesheetType>(
    position?.timesheetType ?? 'standard',
  );
  const save = useActionSubmit<unknown>(
    position ? updatePositionAction : createPositionAction,
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
        title={position ? position.name : 'Add position'}
        leading={
          <IconTile className="size-11 rounded-xl [&_svg]:size-5">
            <BriefcaseBusiness strokeWidth={1.75} />
          </IconTile>
        }
      />
      <SheetBody>
        {position ? <input type="hidden" name="id" value={position.id} /> : null}
        <input type="hidden" name="timesheetType" value={timesheetType} />
        <FormAlert message={save.formError} />
        <FormSection title="Position">
          <FormField label="Name" required error={save.fieldErrors.name}>
            <Input
              name="name"
              defaultValue={position?.name ?? ''}
              maxLength={POSITION_NAME_MAX_LENGTH}
              autoComplete="off"
              autoFocus={!position}
              required
            />
          </FormField>
          {position ? (
            <ReadOnlyField
              label="Department"
              hint="A position’s department can’t be changed. To move it, add a new position in the other department."
            >
              {departmentLabel(position)}
              {position.departmentCode ? ` (${position.departmentCode})` : null}
            </ReadOnlyField>
          ) : (
            <FormField
              label="Department"
              required
              hint="It can’t be changed once the position is added."
              error={save.fieldErrors.departmentId}
            >
              <Select name="departmentId" defaultValue={defaultDepartmentId} required>
                <option value="" disabled>
                  Choose a department
                </option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name} ({department.code})
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </FormSection>
        <FormSection title="Timesheet" footer={TIMESHEET_TYPE_CHANGE_NOTE}>
          <div className="flex flex-col gap-1.5 px-4 py-3">
            <SegmentedControl
              label="Timesheet type"
              options={TIMESHEET_SEGMENTS}
              value={timesheetType}
              onValueChange={setTimesheetType}
              tone="accent"
              fullWidth
            />
            {save.fieldErrors.timesheetType ? (
              <p className="text-footnote font-medium text-destructive-text" role="alert">
                {save.fieldErrors.timesheetType}
              </p>
            ) : null}
          </div>
        </FormSection>
        {position ? (
          <FormSection title="In this position">
            <ReadOnlyField label="Active employees">
              <span className="numeric">{position.activeEmployeeCount}</span>
            </ReadOnlyField>
          </FormSection>
        ) : null}
      </SheetBody>
      <SheetFooter>
        {position ? <RetirePositionButton position={position} onRetired={onRetired} /> : null}
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
          {position ? 'Save' : 'Add position'}
          <ShortcutHint keys={SUBMIT} tone="on-fill" className="hidden sm:inline-flex" />
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Retire, after the destructive confirmation. A refused retire is shown in the dialog. */
function RetirePositionButton({
  position,
  onRetired,
}: {
  position: PositionView;
  onRetired: (name: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const retire = useActionSubmit(retirePositionAction, () => onRetired(position.name));

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
        title={`Retire ${position.name}?`}
        description="It can’t be picked for new employees, and its name stays taken in this department. You can restore it later from “Show retired”."
        confirmLabel="Retire position"
        error={retire.formError}
        onConfirm={async () => {
          const ok = await retire.run({ id: position.id });
          // Keeps the dialog open, showing why, when the retire was refused.
          if (!ok) throw new Error('Retire refused');
        }}
      />
    </>
  );
}

/** A retired position: its details, and Restore. */
function RetiredPosition({
  position,
  onRestored,
}: {
  position: PositionView;
  onRestored: () => void;
}) {
  const restore = useActionSubmit(restorePositionAction, onRestored);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SheetHeader
        title={position.name}
        leading={
          <IconTile className="size-11 rounded-xl [&_svg]:size-5">
            <BriefcaseBusiness strokeWidth={1.75} />
          </IconTile>
        }
      />
      <SheetBody>
        <FormAlert message={restore.formError} />
        <FormSection
          title="Position"
          footer={
            position.departmentRetired
              ? 'Its department is retired. Restore the department first, then this position.'
              : position.retiredAt
                ? `Retired on ${formatDate(position.retiredAt)}. Restore it to edit it or pick it again.`
                : undefined
          }
        >
          <ReadOnlyField label="Name">{position.name}</ReadOnlyField>
          <ReadOnlyField label="Department">
            {departmentLabel(position)}
            {position.departmentCode ? ` (${position.departmentCode})` : null}
            {position.departmentRetired ? ', retired' : null}
          </ReadOnlyField>
          <ReadOnlyField label="Timesheet type">
            {TIMESHEET_TYPE_LABELS[position.timesheetType]}
          </ReadOnlyField>
        </FormSection>
      </SheetBody>
      <SheetFooter>
        <SheetClose asChild>
          <Button variant="secondary" className="pr-3">
            Close
            <ShortcutHint keys={['escape']} className="hidden sm:inline-flex" />
          </Button>
        </SheetClose>
        <Button loading={restore.pending} onClick={() => void restore.run({ id: position.id })}>
          Restore position
        </Button>
      </SheetFooter>
    </div>
  );
}
