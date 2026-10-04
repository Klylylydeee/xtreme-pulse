import type { ScheduleDefinition } from '@pulse/core/server';
import type { JobHandler } from '@pulse/core/server/worker';
import { coreJobHandlers, coreJobSchedules } from './core-jobs';
import { devJobHandlers, devJobSchedules } from './dev-jobs';

// Every job the worker runs and every schedule it registers. Each module adds its handlers and
// schedules here as it is built (docs/ARCHITECTURE.md#background-jobs lists them). A schedule
// removed from this list is unregistered on the next start.

export function jobHandlers({ production }: { production: boolean }): JobHandler[] {
  return [...coreJobHandlers, ...(production ? [] : devJobHandlers)];
}

export function jobSchedules({ production }: { production: boolean }): ScheduleDefinition[] {
  return [...coreJobSchedules, ...(production ? [] : devJobSchedules)];
}
