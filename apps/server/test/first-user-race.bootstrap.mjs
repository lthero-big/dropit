import { tsImport } from 'tsx/esm/api';

// Register tsx inside the worker so .js source imports resolve to TypeScript.
await tsImport('./first-user-race.worker.ts', import.meta.url);
