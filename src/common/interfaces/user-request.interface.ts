import { Request } from 'express';

export interface JwtPayload {
  userId: number;
  email: string;
  username: string;
  role: string; // Single role (matches JWT payload from auth.service.ts)
}

export interface UserRequest extends Request {
  user: JwtPayload;
}
