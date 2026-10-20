import type { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { Server } from 'node:http';

import request from 'supertest';
import type { DataSource } from 'typeorm';

import { User } from '../../src/users/entities';
import { FINANCE_PERMISSIONS } from '../../src/payments/finance-permissions';
import { createAuthenticatedUser, createE2EApp, resetDatabase, type AuthenticatedUser } from './fixtures';

/**
 * API audit — runtime authorization sweep over EVERY registered route.
 *
 * Static metadata says a guard is declared; only a request proves it is enforced and
 * that the handler survives hostile input. For each route this spec checks, over real
 * HTTP against the full application:
 *
 *   A. anonymous caller      -> 401 wherever an authenticating guard is declared
 *   B. caller of a role the route does NOT list -> 403 (or 401/404 for hidden resources never 2xx)
 *   C. caller of each role the route DOES list, with an empty body and a random id
 *                            -> never a 5xx (an unhandled exception or DI failure)
 *
 * Side-effect routes that would end the sweep's own sessions are skipped explicitly.
 */

const RANDOM_UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const ROLES = ['admin', 'teacher', 'student', 'call_center'] as const;
type Role = (typeof ROLES)[number];

const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};

/** Routes the sweep must not call as an authenticated caller (they end the very session under test). */
const SKIP_AUTHENTICATED = new Set<string>([
  'DELETE /api/v1/users/me',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/register',
]);

/** Guards that authenticate the caller; a missing credential must end in 401. */
const AUTHENTICATING = new Set([
  'JwtAuthGuard',
  'HybridAuthGuard',
  'FirebaseAuthGuard',
  'RolesGuard',
  'ApprovedInstructorGuard',
  'FinancePermissionsGuard',
  'MetricsBearerGuard',
]);

interface Route {
  method: string;
  httpMethod: string;
  path: string;
  concretePath: string;
  controller: string;
  handler: string;
  guards: string[];
  roles: Role[];
}

function pathJoin(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return `/${joined}`;
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String) : [typeof v === 'string' ? v : ''];
}

function collectRoutes(app: INestApplication): Route[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const reflector = app.get(Reflector);
  const out: Route[] = [];
  for (const { instance, metatype } of discovery.getControllers()) {
    if (!instance || !metatype) continue;
    const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
    for (const name of scanner.getAllMethodNames(proto)) {
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const code = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      const httpMethod = code === undefined ? undefined : METHODS[code];
      if (httpMethod === undefined) continue;
      const guards = new Set<string>();
      for (const t of [metatype, handler]) {
        for (const g of (reflector.get<Array<{ name?: string }>>(GUARDS_METADATA, t as never) ?? [])) {
          guards.add(typeof g === 'function' ? (g as { name: string }).name : 'anonymous');
        }
      }
      const roles = (reflector.getAllAndMerge<string[]>('roles', [handler, metatype]) ?? []).filter((r): r is Role =>
        (ROLES as readonly string[]).includes(r),
      );
      for (const cp of asArray(Reflect.getMetadata(PATH_METADATA, metatype))) {
        for (const hp of asArray(Reflect.getMetadata(PATH_METADATA, handler))) {
          const bare = pathJoin(cp, hp);
          const path = httpMethod === 'get' && bare === '/metrics' ? bare : pathJoin('api/v1', cp, hp);
          out.push({
            method: httpMethod.toUpperCase(),
            httpMethod,
            path,
            concretePath: path.replace(/:[A-Za-z0-9_]+/g, RANDOM_UUID),
            controller: metatype.name,
            handler: name,
            guards: [...guards].sort(),
            roles: [...new Set(roles)],
          });
        }
      }
    }
  }
  return out;
}

describe('route authorization sweep (every registered route, over HTTP)', () => {
  let app: INestApplication;
  let server: Server;
  let dataSource: DataSource;
  let routes: Route[];
  const agents = {} as Record<Role, AuthenticatedUser>;

  beforeAll(async () => {
    ({ app, dataSource } = await createE2EApp());
    server = app.getHttpServer() as Server;
    routes = collectRoutes(app);
    await resetDatabase(dataSource);
    for (const role of ROLES) {
      agents[role] = await createAuthenticatedUser(app, dataSource, { role });
    }
    await dataSource.getRepository(User).update({ id: agents.admin.userId }, { finance_permissions: [...FINANCE_PERMISSIONS] as never });
  }, 180_000);

  afterAll(async () => {
    await app.close();
  });

  async function call(r: Route, as: Role | null): Promise<number> {
    const base = as === null ? request(server) : (agents[as].agent as unknown as ReturnType<typeof request>);
    const req = (base as unknown as Record<string, (p: string) => request.Test>)[r.httpMethod](r.concretePath);
    const res = await (['post', 'put', 'patch'].includes(r.httpMethod) ? req.send({}) : req).timeout({ deadline: 20_000 });
    return res.status;
  }

  it('discovers a plausible number of routes', () => {
    expect(routes.length).toBeGreaterThan(600);
  });

  it('A. anonymous callers get 401 on every route that declares an authenticating guard', async () => {
    const findings: string[] = [];
    for (const r of routes) {
      if (!r.guards.some((g) => AUTHENTICATING.has(g))) continue;
      let status: number;
      try {
        status = await call(r, null);
      } catch (e) {
        findings.push(`${r.method} ${r.path} -> request failed: ${(e as Error).message}`);
        continue;
      }
      if (status !== 401) findings.push(`${r.method} ${r.path} -> ${status} (guards: ${r.guards.join('+')})`);
    }
    expect(findings).toEqual([]);
  }, 600_000);

  it('B. a caller whose role the route does not list is refused (never 2xx, never 5xx)', async () => {
    const findings: string[] = [];
    for (const r of routes) {
      if (r.roles.length === 0 || !r.guards.includes('RolesGuard')) continue;
      const wrong = ROLES.find((role) => !r.roles.includes(role));
      if (wrong === undefined || SKIP_AUTHENTICATED.has(`${r.method} ${r.path}`)) continue;
      let status: number;
      try {
        status = await call(r, wrong);
      } catch (e) {
        findings.push(`${r.method} ${r.path} as ${wrong} -> request failed: ${(e as Error).message}`);
        continue;
      }
      if (status !== 403) findings.push(`${r.method} ${r.path} as ${wrong} (allowed: ${r.roles.join(',')}) -> ${status}`);
    }
    expect(findings).toEqual([]);
  }, 600_000);

  it('C. an authorised caller sending an empty body and an unknown id never triggers a 5xx', async () => {
    const findings: string[] = [];
    for (const r of routes) {
      if (SKIP_AUTHENTICATED.has(`${r.method} ${r.path}`)) continue;
      const roles: Role[] = r.roles.length > 0 ? r.roles : ['student'];
      for (const role of roles) {
        let status: number;
        try {
          status = await call(r, role);
        } catch (e) {
          findings.push(`${r.method} ${r.path} as ${role} -> request failed: ${(e as Error).message}`);
          continue;
        }
        if (status >= 500) findings.push(`${r.method} ${r.path} as ${role} -> ${status} (${r.controller}.${r.handler})`);
      }
    }
    expect(findings).toEqual([]);
  }, 900_000);
});
