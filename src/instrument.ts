/**
 * Monitoring bootstrap — imported for its side effects at the very top of
 * `main.ts` (before the Nest app is created). Keeps `main.ts` import-only.
 */
import { initSentry, registerGlobalErrorHandlers } from './observability/sentry';

initSentry();
registerGlobalErrorHandlers();
