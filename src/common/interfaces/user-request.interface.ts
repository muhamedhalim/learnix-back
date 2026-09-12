import type { Request } from 'express';

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
  /** Optional until tenancy claims are enabled; cache scopes already support it. */
  tenantId?: string;
}

export interface UserRequest extends Request {
  user?: JwtPayload;
}
