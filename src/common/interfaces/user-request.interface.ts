import type { Request } from 'express';

export interface JwtPayload {
  userId: string;
  email: string;
  name: string;
  role: string; // Single role (matches JWT payload from auth.service.ts)
}

export interface UserRequest extends Request {
  user?: JwtPayload;
}
