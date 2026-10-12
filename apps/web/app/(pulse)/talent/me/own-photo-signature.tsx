'use client';

import { type ChangeEvent, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleAlert, CircleCheck, PenLine } from 'lucide-react';
import { fieldError, formatDate } from '@pulse/core';
import type { ESignatureStatusView, OwnESignatureVersionView } from '@pulse/talent';
import { cn } from '@pulse/ui';
import { Button } from '@pulse/ui/components/button';
import { Badge } from '@/components/org-structure';
import { uploadOwnESignatureAction } from '@/lib/actions/talent-self';
import type { UploadHint } from '@/lib/upload-hints';
import { PhotoControls } from '../photo-controls';

// Spec: docs/modules/talent.md#documents-photo-e-signature-and-certifications-build-step-22
// (decisions 173 and 175), SECURITY.md#exceptions-to-module-access and
// docs/DESIGN_SYSTEM.md#layout--components ("Photo and e-signature") — the employee's own photo
// (Change, Remove) and e-signature on `/talent/me`: a preview on a `logo-tile` square with a
// hairline border (so dark ink reads in both appearances), Upload or Replace, and the version
// history with how often each version was applied. A signature is replaced, never removed; signed
// records keep the version they were signed with. Every action acts on the signed-in user's own
// employee only. Nothing here is logged.

const UPLOAD_FAILED = 'The e-signature wasn’t uploaded. Check your connection and try again.';

function timesApplied(count: number): string {
  if (count === 0) return 'Not applied yet';
  return count === 1 ? 'Applied once' : `Applied ${count} times`;
}

/** A signature image on its white tile. */
function SignatureTile({ src, alt, className }: { src: string; alt: string; className?: string }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-separator bg-logo-tile p-2',
        className,
      )}
    >
      {/* A plain image: it opens through the access-checked file route, not next/image. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} decoding="async" className="size-full object-contain" />
    </span>
  );
}

export function OwnPhotoAndSignature({
  firstName,
  lastName,
  photoUrl,
  canChangePhoto,
  eSignature,
  versions,
  canUploadSignature,
  imageUpload,
}: {
  firstName: string;
  lastName: string;
  photoUrl: string | null;
  canChangePhoto: boolean;
  eSignature: ESignatureStatusView;
  versions: OwnESignatureVersionView[];
  canUploadSignature: boolean;
  /** The accepted image types and size limit. */
  imageUpload: UploadHint;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const titleId = useId();
  const historyId = useId();

  function changed(message: string) {
    setNotice(message);
    router.refresh();
  }

  async function choose(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    // Clear the input, so choosing the same file again still uploads it.
    event.currentTarget.value = '';
    if (!file) return;
    const formData = new FormData();
    formData.set('signature', file);
    setError(null);
    setNotice(null);
    setUploading(true);
    try {
      const result = await uploadOwnESignatureAction(null, formData);
      if (result.ok) changed(`E-signature uploaded as version ${result.data.version}.`);
      else setError(fieldError(result, 'signature') ?? result.formError ?? UPLOAD_FAILED);
    } catch {
      setError(UPLOAD_FAILED);
    } finally {
      setUploading(false);
    }
  }

  const current = eSignature.version;
  return (
    <section aria-labelledby={titleId} className="flex flex-col gap-2">
      <h3
        id={titleId}
        className="flex min-h-11 items-center pl-4 text-footnote font-semibold text-text-secondary"
      >
        Photo and e-signature
      </h3>
      <div role="status" className="empty:hidden">
        {notice ? (
          <p className="flex items-start gap-2 rounded-card bg-surface px-4 py-3 text-footnote font-medium text-success-text shadow-card">
            <CircleCheck aria-hidden="true" className="mt-px size-4 shrink-0" />
            <span>{notice}</span>
          </p>
        ) : null}
      </div>
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card">
        <PhotoControls
          target={{ kind: 'self' }}
          photoUrl={photoUrl}
          firstName={firstName}
          lastName={lastName}
          canChange={canChangePhoto}
          accept={imageUpload.accept}
          hint={imageUpload.hint}
          onChanged={changed}
        />
        <div className="flex flex-col gap-3 px-4 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {eSignature.imageUrl ? (
              <SignatureTile
                src={eSignature.imageUrl}
                alt={`Your e-signature, version ${current ?? ''}`}
                className="size-40"
              />
            ) : (
              <span className="flex size-40 shrink-0 items-center justify-center rounded-lg border border-dashed border-separator text-text-secondary">
                <PenLine aria-hidden="true" className="size-8" strokeWidth={1.5} />
              </span>
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-subheadline font-medium">
                {current === null ? 'No e-signature yet' : `E-signature, version ${current}`}
              </p>
              <p className="text-footnote text-text-secondary">
                Applied when you approve requests. Only you and the System Administrator see the
                image. Replacing it keeps already-signed records on the version they were signed
                with.
              </p>
              {canUploadSignature ? (
                <p className="text-footnote text-text-secondary">
                  {imageUpload.hint} Dark ink on a white or clear background works best.
                </p>
              ) : null}
            </div>
          </div>
          {canUploadSignature ? (
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                ref={inputRef}
                type="file"
                name="signature"
                accept={imageUpload.accept}
                hidden
                tabIndex={-1}
                onChange={(event) => void choose(event)}
              />
              <Button
                variant="tinted"
                loading={uploading}
                disabled={!imageUpload.accept}
                onClick={() => inputRef.current?.click()}
              >
                <PenLine aria-hidden="true" strokeWidth={1.75} />
                {current === null ? 'Upload e-signature' : 'Replace e-signature'}
              </Button>
            </div>
          ) : null}
          <div role="alert" className="empty:hidden">
            {error ? (
              <p className="flex items-start gap-1.5 text-footnote font-medium text-destructive-text">
                <CircleAlert aria-hidden="true" className="mt-px size-4 shrink-0" />
                <span>{error}</span>
              </p>
            ) : null}
          </div>
        </div>
      </div>
      {versions.length > 0 ? (
        <div className="flex flex-col gap-2 pt-2">
          <h4 id={historyId} className="px-4 text-footnote font-semibold text-text-secondary">
            Version history
          </h4>
          <ol
            aria-labelledby={historyId}
            className="flex flex-col divide-y divide-separator overflow-hidden rounded-card bg-surface shadow-card"
          >
            {versions.map((version) => (
              <li key={version.id} className="flex items-center gap-3 px-4 py-2.5">
                <SignatureTile
                  src={version.imageUrl}
                  alt={`Version ${version.version}`}
                  className="size-12 p-1"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="numeric text-subheadline font-semibold">
                      Version {version.version}
                    </span>
                    {version.current ? <Badge tone="accent">Current</Badge> : null}
                  </span>
                  <span className="numeric text-footnote text-text-secondary">
                    Uploaded {formatDate(version.uploadedAt)} ·{' '}
                    {timesApplied(version.applicationCount)}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
