'use client';

import { type ChangeEvent, useRef, useState } from 'react';
import { CircleAlert, ImageUp, Trash2 } from 'lucide-react';
import { fieldError } from '@pulse/core';
import { Avatar } from '@pulse/ui/components/avatar';
import { Button } from '@pulse/ui/components/button';
import { DestructiveConfirmDialog } from '@pulse/ui/components/confirm-dialog';
import { removeEmployeePhotoAction, setEmployeePhotoAction } from '@/lib/actions/talent';
import { removeOwnPhotoAction, setOwnPhotoAction } from '@/lib/actions/talent-self';

// Spec: docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22
// (decision 173) and docs/DESIGN_SYSTEM.md#layout--components ("Photo and e-signature") — the
// profile photo as a large Avatar with Change and Remove. Choosing a file uploads it at once (the
// server re-encodes it as WebP and strips its metadata); Remove asks first. `self` is the
// employee's own photo on `/talent/me` (a signed-in user, their own employee only); `employee` is
// the inspector's, where Core's service allows HR, the System Administrator and the employee.

export type PhotoTarget = { kind: 'self' } | { kind: 'employee'; employeeId: string };

const UPLOAD_FAILED = 'The photo wasn’t uploaded. Check your connection and try again.';
const REMOVE_FAILED = 'The photo wasn’t removed. Check your connection and try again.';

export function PhotoControls({
  target,
  photoUrl,
  firstName,
  lastName,
  canChange,
  accept,
  hint,
  onChanged,
}: {
  target: PhotoTarget;
  photoUrl: string | null;
  firstName: string;
  lastName: string;
  canChange: boolean;
  /** The file input's `accept`, from the upload settings. */
  accept: string;
  /** The accepted types and size limit. */
  hint: string;
  /** After a change: reload what shows the photo and say `message`. */
  onChanged: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const name = `${firstName} ${lastName}`;
  const own = target.kind === 'self';

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    // Clear the input, so choosing the same file again still uploads it.
    event.currentTarget.value = '';
    if (!file) return;
    const formData = new FormData();
    formData.set('photo', file);
    if (target.kind === 'employee') formData.set('employeeId', target.employeeId);
    setError(null);
    setUploading(true);
    try {
      const result =
        target.kind === 'self'
          ? await setOwnPhotoAction(null, formData)
          : await setEmployeePhotoAction(null, formData);
      if (result.ok) onChanged('Photo changed.');
      else setError(fieldError(result, 'photo') ?? result.formError ?? UPLOAD_FAILED);
    } catch {
      setError(UPLOAD_FAILED);
    } finally {
      setUploading(false);
    }
  }

  async function remove() {
    setRemoveError(null);
    let failed: string | null = null;
    try {
      const result =
        target.kind === 'self'
          ? await removeOwnPhotoAction(null, {})
          : await removeEmployeePhotoAction(null, { employeeId: target.employeeId });
      if (!result.ok) failed = result.formError ?? REMOVE_FAILED;
    } catch {
      failed = REMOVE_FAILED;
    }
    if (failed) {
      setRemoveError(failed);
      // Keeps the dialog open with the error.
      throw new Error('Not removed');
    }
    onChanged('Photo removed.');
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Avatar
          firstName={firstName}
          lastName={lastName}
          photoUrl={photoUrl}
          className="size-20 text-title-2"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-subheadline font-medium">
            {photoUrl ? 'Profile photo' : 'No photo yet'}
          </p>
          <p className="text-footnote text-text-secondary">
            {photoUrl
              ? 'Everyone in the company sees it wherever the name appears.'
              : 'Avatars show the initials until a photo is added.'}
          </p>
          {canChange ? <p className="text-footnote text-text-secondary">{hint}</p> : null}
        </div>
      </div>
      {canChange ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={inputRef}
            type="file"
            name="photo"
            accept={accept}
            hidden
            tabIndex={-1}
            onChange={(event) => void choose(event)}
          />
          <Button
            variant="tinted"
            loading={uploading}
            disabled={!accept}
            onClick={() => inputRef.current?.click()}
            aria-label={own ? undefined : `Change ${name}’s photo`}
          >
            <ImageUp aria-hidden="true" strokeWidth={1.75} />
            {photoUrl ? 'Change photo' : 'Add photo'}
          </Button>
          {photoUrl ? (
            <DestructiveConfirmDialog
              trigger={
                <Button
                  variant="secondary"
                  className="text-destructive-text"
                  aria-label={own ? undefined : `Remove ${name}’s photo`}
                >
                  <Trash2 aria-hidden="true" strokeWidth={1.75} />
                  Remove photo
                </Button>
              }
              onOpenChange={(open) => {
                if (open) setRemoveError(null);
              }}
              title={own ? 'Remove your photo?' : `Remove ${name}’s photo?`}
              description="Avatars will show the initials until a new photo is added."
              confirmLabel="Remove photo"
              onConfirm={remove}
              error={removeError}
            />
          ) : null}
        </div>
      ) : null}
      {/* Always rendered, so a new error is announced as it appears. */}
      <div role="alert" className="empty:hidden">
        {error ? (
          <p className="flex items-start gap-1.5 text-footnote font-medium text-destructive-text">
            <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
