'use client';

import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import type { TimeOffRequestView } from '@pulse/talent';
import type { EmployeeTimeOffView, OwnTimeOffView } from '@pulse/talent/server';
import { Button } from '@pulse/ui/components/button';
import { PageHeader } from '@pulse/ui/components/page-header';
import { Sheet, SheetContent } from '@pulse/ui/components/sheet';
import type { UploadHint } from '@/lib/upload-hints';
import { BalanceCards } from './balance-cards';
import { RequestList } from './request-list';
import { CancelRequestForm, TimeOffRequestForm, type TimeOffSheetMode } from './request-sheet';

// Spec: docs/modules/talent.md#leave-offset-time-off-and-opening-balances-build-step-28
// ("Screens") and docs/DESIGN_SYSTEM.md#layout--components ("Time off on a phone") — one view for
// the own time off (`/talent/time-off`) and someone's, read-only (`/talent/time-off/<employeeId>`),
// laid out like the timesheet: the large title, the balances (VL, SL and offset, then the
// statutory types used this year), the requests newest first, and on the own page a sticky glass
// footer with "File time off", which opens the request sheet. A returned request has "Edit and
// send again" and "Cancel", an approved one before its first day "Cancel request"; `#resend-<id>`
// and `#cancel-<id>` in the address open those sheets (the request page links here with them).
// Someone else's page has no footer and no actions: the server refuses every change anyway.

type SheetState =
  { view: 'request'; mode: TimeOffSheetMode } | { view: 'cancel'; request: TimeOffRequestView };

function isOwnView(view: EmployeeTimeOffView | OwnTimeOffView): view is OwnTimeOffView {
  return view.own && 'sheet' in view;
}

export function TimeOffScreen({
  view,
  upload,
}: {
  view: EmployeeTimeOffView | OwnTimeOffView;
  /** Own page: the attachment field's accepted types and size limit. */
  upload?: UploadHint;
}) {
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const own = isOwnView(view) ? view : null;

  // `#resend-<id>` or `#cancel-<id>` (the request page's links): open that sheet on load (after
  // the first frame) and whenever the hash changes, when the request still allows it.
  const requestsRef = useRef(view.requests);
  useEffect(() => {
    requestsRef.current = view.requests;
  });
  useEffect(() => {
    if (!own) return;
    function openFromHash() {
      const match = /^#(resend|cancel)-([a-f\d]{24})$/i.exec(window.location.hash);
      if (!match) return;
      const request = requestsRef.current.find((candidate) => candidate.id === match[2]);
      if (!request) return;
      if (match[1] === 'resend' && request.canEditAndResend) {
        setSheet({ view: 'request', mode: { kind: 'resend', request } });
      } else if (match[1] === 'cancel' && request.canCancel) {
        setSheet({ view: 'cancel', request });
      }
    }
    const frame = requestAnimationFrame(openFromHash);
    window.addEventListener('hashchange', openFromHash);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('hashchange', openFromHash);
    };
  }, [own]);

  function close() {
    setSheet(null);
    // A hash that opened the sheet would open it again on the next load.
    if (/^#(resend|cancel)-/.test(window.location.hash)) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
  }

  return (
    <div className="flex w-full max-w-2xl min-w-0 flex-col gap-5">
      <PageHeader
        title={own ? 'Time off' : view.employee.name}
        description={
          own ? (
            'Your leave and offset balances, and the time off you file.'
          ) : (
            <>
              <span className="numeric">{view.employee.employeeNumber}</span> · Time off
            </>
          )
        }
      />

      <BalanceCards balances={view.balances} offset={view.offset} />

      <RequestList
        requests={view.requests}
        own={Boolean(own)}
        onResend={(request) => setSheet({ view: 'request', mode: { kind: 'resend', request } })}
        onCancel={(request) => setSheet({ view: 'cancel', request })}
      />

      {own ? (
        <div
          role="region"
          aria-label="File time off"
          className="sticky bottom-[max(1rem,env(safe-area-inset-bottom))] z-10 flex flex-col gap-3 rounded-card glass px-4 py-3 shadow-float sm:flex-row sm:items-center"
        >
          <p className="min-w-0 flex-1 text-footnote text-text-secondary">
            Leave or offset time off goes to your supervisor for approval.
          </p>
          <Button
            onClick={() => setSheet({ view: 'request', mode: { kind: 'file' } })}
            className="h-13 w-full text-body sm:w-auto"
          >
            <Plus aria-hidden="true" className="size-5" />
            File time off
          </Button>
        </div>
      ) : null}

      {own ? (
        <Sheet open={sheet !== null} onOpenChange={(open) => (open ? undefined : close())}>
          <SheetContent aria-describedby={undefined}>
            {sheet?.view === 'request' ? (
              <TimeOffRequestForm
                key={sheet.mode.kind === 'resend' ? sheet.mode.request.id : 'file'}
                mode={sheet.mode}
                sheet={own.sheet}
                today={own.today}
                upload={upload ?? { accept: '', hint: '' }}
                onDone={close}
              />
            ) : null}
            {sheet?.view === 'cancel' ? (
              <CancelRequestForm key={sheet.request.id} request={sheet.request} onDone={close} />
            ) : null}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}
