/**
 * Registers the process driver. Imported from the drivers barrel
 * (`installed.ts`); the driver itself stays side-effect free so tests can
 * build it directly. Selected with NANOCLAW_RUNTIME_DRIVER=process.
 */
import { registerSessionDriver } from './driver-registry.js';
import { ProcessSessionDriver, processDriverOptionsFromEnv } from './process-driver.js';

registerSessionDriver('process', (policy) => new ProcessSessionDriver({ ...policy, ...processDriverOptionsFromEnv(process.env) }));
