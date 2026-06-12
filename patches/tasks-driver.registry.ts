// FreeBSD daemonless patch for Papra's task-driver registry.
//
// WHY: This module statically imports the libsql task driver, which does
// `import { createClient } from '@libsql/client'` at module-eval time. On FreeBSD
// that eagerly loads the native `libsql` package and crashes the whole process
// with `Cannot find module '@libsql/freebsd-x64'` — even when the configured
// driver is `memory` (the default) and the libsql driver is never instantiated.
//
// FIX: drop the static libsql import. The `memory` driver is the supported and
// default driver for a single-instance self-host (see tasks.config.ts), and is
// all this image needs. Selecting `libsql` now throws a clear error instead of
// crashing at import time. (The libsql/Turso task backend can't work on FreeBSD
// anyway — same native-module limitation as the main DB; see patches/database.ts.)

import type { TaskServiceDriverFactory } from '../tasks.types';
import { createMemoryTaskServiceDriver } from './memory/memory.tasks-driver';
import { TASKS_DRIVER_NAMES } from './tasks-driver.constants';

const unsupportedLibSqlDriver: TaskServiceDriverFactory = (() => {
  throw new Error(
    'The libsql tasks driver is not available in the FreeBSD daemonless image '
    + '(the native libsql client cannot load on FreeBSD). Use TASKS_PERSISTENCE_DRIVER=memory.',
  );
}) as unknown as TaskServiceDriverFactory;

export const tasksDrivers = {
  [TASKS_DRIVER_NAMES.memory]: createMemoryTaskServiceDriver,
  [TASKS_DRIVER_NAMES.libsql]: unsupportedLibSqlDriver,
} as const satisfies Record<string, TaskServiceDriverFactory>;
