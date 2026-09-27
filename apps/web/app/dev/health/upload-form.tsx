'use client';

import { useActionState } from 'react';
import { CircleCheck } from 'lucide-react';
import { fieldError } from '@pulse/core';
import { Button } from '@pulse/ui/components/button';
import { FormField, FormSection, Input } from '@pulse/ui/components/form';
import { type TestUploadResult, uploadTestFile } from './actions';

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function Result({ file }: { file: TestUploadResult }) {
  return (
    <div className="flex flex-col gap-1 px-4 py-3" role="status">
      <p className="flex items-center gap-2 text-body">
        <CircleCheck
          aria-hidden="true"
          className="size-5 shrink-0 text-success-text"
          strokeWidth={1.75}
        />
        <span className="min-w-0 break-words">
          Saved.{' '}
          <a href={file.url} className="font-medium text-accent underline-offset-2 hover:underline">
            Open {file.name}
          </a>
        </span>
      </p>
      <p className="text-footnote break-all text-text-secondary">
        Stored as {file.storedAs} · {file.contentType} · {formatSize(file.sizeBytes)}
      </p>
    </div>
  );
}

/** Development test upload: stores a file and links to it through the file route. */
export function UploadForm({ limitsHint }: { limitsHint: string }) {
  const [result, action, pending] = useActionState(uploadTestFile, null);
  return (
    <form action={action} className="flex flex-col gap-3">
      <FormSection
        title="Test upload"
        footer="The file is saved under a generated name and opens only through /files/<id>."
      >
        <FormField label="File" hint={limitsHint} error={fieldError(result, 'file')} required>
          <Input
            type="file"
            name="file"
            required
            className="py-2 file:mr-3 file:rounded-md file:border-0 file:bg-accent-subtle file:px-3 file:py-1 file:text-subheadline file:font-medium file:text-accent"
          />
        </FormField>
        {result?.ok ? <Result file={result.data} /> : null}
        {result && !result.ok && result.formError ? (
          <p role="alert" className="px-4 py-3 text-footnote font-medium text-destructive-text">
            {result.formError}
          </p>
        ) : null}
      </FormSection>
      <div className="flex justify-end px-4">
        <Button type="submit" loading={pending}>
          Upload
        </Button>
      </div>
    </form>
  );
}
