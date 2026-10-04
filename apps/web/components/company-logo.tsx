import { cn } from '@pulse/ui';
import { LogoPlaceholder } from './logo-placeholder';

/**
 * The company logo from company settings (docs/modules/core.md#company-settings-page), or the
 * placeholder mark while none is uploaded. `logoUrl` is the public `/company-logo?v=<fileId>` URL;
 * read it with `getCompanyLogoUrl()` on the server. Size comes from `className`, and
 * `placeholderClassName` restyles only the placeholder. An uploaded logo always sits on the
 * `logo-tile` (DESIGN_SYSTEM.md › Color), which stays white in dark mode, so a transparent logo
 * drawn for a light background, or one in the hero's own blue, still shows.
 */
export function CompanyLogo({
  logoUrl,
  className,
  placeholderClassName,
}: {
  logoUrl: string | null;
  className?: string;
  placeholderClassName?: string;
}) {
  if (!logoUrl) return <LogoPlaceholder className={cn(className, placeholderClassName)} />;
  return (
    <span
      className={cn(
        'flex size-8 shrink-0 overflow-hidden rounded-lg border border-separator bg-logo-tile p-1',
        className,
      )}
    >
      {/* A plain image: the route already caches each logo version for good, and next/image would
          need `images.localPatterns` for the `?v=` cache buster. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={logoUrl} alt="Company logo" className="size-full object-contain" />
    </span>
  );
}
