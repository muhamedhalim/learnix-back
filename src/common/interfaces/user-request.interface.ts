import type { Request } from 'express';

import type { FinancePermission } from '../auth/finance-permissions';

export interface JwtPayload {
  userId: string;
  email: string;
  name: string;
  /**
   * Single academic role, or null for a marketplace-only identity (an approved
   * instructor with no academic role). Null never satisfies a `@Roles(...)`
   * check, so such a principal is denied every academic route by default and
   * reaches marketplace routes through `ApprovedInstructorGuard` instead.
   */
  role: string | null;
  sessionId?: string;
  /**
   * Loaded from the live principal statement on cookie-authenticated requests
   * (never from the JWT). Absent for Firebase bearers, where consumers fall
   * back to a database read.
   */
  financePermissions?: FinancePermission[];
  /** Optional until tenancy claims are enabled; cache scopes already support it. */
  tenantId?: string;
}

export interface UserRequest extends Request {
  user?: JwtPayload;
}
