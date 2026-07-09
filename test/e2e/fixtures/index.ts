/**
 * Convenience barrel for E2E building blocks — app factory, DB reset, auth
 * helpers and data factories — so specs import from a single place.
 */
export {
  API_PREFIX,
  createE2EApp,
  createE2EAppWithCsrf,
  type E2EContext,
} from '../helpers/app-factory';
export { resetDatabase, setUserRole, setUserStatus } from '../helpers/database';
export {
  bearer,
  createAuthenticatedUser,
  type AuthenticatedUser,
} from '../helpers/auth';
export {
  buildRegisterPayload,
  type RegisterPayload,
} from '../factories/user.factory';
