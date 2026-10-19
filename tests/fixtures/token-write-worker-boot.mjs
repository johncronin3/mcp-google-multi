import { workerData } from 'node:worker_threads';
import { tsImport } from 'tsx/esm/api';

await tsImport(workerData.entry, import.meta.url);
