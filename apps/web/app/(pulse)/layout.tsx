import type { ReactNode } from 'react';
import { PulseShell } from '@/components/pulse-shell';

/**
 * The signed-in shell. Phase 1 adds the session and account status check here (steps 1.2 and 1.5)
 * and lists only the modules the user can open (step 1.6).
 */
export default function PulseLayout({ children }: { children: ReactNode }) {
  return <PulseShell>{children}</PulseShell>;
}
