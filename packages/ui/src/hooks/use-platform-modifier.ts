'use client';

import { useSyncExternalStore } from 'react';

export type PlatformModifier = '⌘' | 'Ctrl';

type NavigatorWithUAData = Navigator & { userAgentData?: { platform?: string } };

function readModifier(): PlatformModifier {
  const nav = navigator as NavigatorWithUAData;
  const platform = nav.userAgentData?.platform ?? nav.platform;
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘' : 'Ctrl';
}

function subscribe(): () => void {
  return () => {};
}

/**
 * The shortcut modifier for the user's platform: ⌘ on Apple devices, Ctrl elsewhere
 * (DESIGN_SYSTEM.md › Pro-app layout). `null` during server rendering, before the platform is known.
 */
export function usePlatformModifier(): PlatformModifier | null {
  return useSyncExternalStore(subscribe, readModifier, () => null);
}
