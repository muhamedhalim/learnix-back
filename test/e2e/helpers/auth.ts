import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import request from 'supertest';

import { API_PREFIX } from './app-factory';
import { setUserRole, setUserStatus } from './database';
import { buildRegisterPayload, type RegisterPayload } from '../factories/user.factory';

export interface AuthenticatedUser {
  agent: ReturnType<typeof request.agent>;
  userId: string;
  role: string;
  credentials: RegisterPayload;
  cookies: string[];
}

/**
 * Register a user, approve them directly in the DB (skipping the admin flow),
 * optionally set a role, then log in. Returns a supertest agent that carries the
 * HttpOnly access and refresh cookies.
 */
export async function createAuthenticatedUser(
  app: INestApplication,
  dataSource: DataSource,
  options: { role?: string; overrides?: Partial<RegisterPayload> } = {},
): Promise<AuthenticatedUser> {
  const server = app.getHttpServer() as Server;
  const credentials = buildRegisterPayload(options.overrides);

  const registerRes = await request(server)
    .post(`${API_PREFIX}/auth/register`)
    .send(credentials)
    .expect(201);

  const userId = registerRes.body.userId as string;

  await setUserStatus(dataSource, userId, 'approved');
  if (options.role !== undefined) {
    await setUserRole(dataSource, userId, options.role);
  }

  const agent = request.agent(server);
  const loginRes = await agent
    .post(`${API_PREFIX}/auth/login`)
    .send({ email: credentials.email, password: credentials.password })
    .expect(200);

  return {
    agent,
    userId,
    role: (loginRes.body.role as string) ?? options.role ?? 'student',
    credentials,
    cookies: (loginRes.headers['set-cookie'] as unknown as string[]) ?? [],
  };
}
