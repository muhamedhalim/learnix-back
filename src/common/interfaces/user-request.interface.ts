import type { Request } from 'express';

export interface JwtPayload {
  userId: string;
  email: string;
  name: string;
  role: string; // Single role (matches JWT payload from auth.service.ts)
  sessionId?: string;
  /** Optional until tenancy claims are enabled; cache scopes already support it. */
  tenantId?: string;
}

export interface UserRequest extends Request {
  user?: JwtPayload;
}
