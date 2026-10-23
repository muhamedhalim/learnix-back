import type { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

/** Shared route enumeration for the whole-API sweeps (authorization, CSRF). */
export const RANDOM_UUID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
export const ROLES = ['admin', 'teacher', 'student', 'call_center'] as const;
export type Role = (typeof ROLES)[number];

export const METHODS: Record<number, string> = {
  [RequestMethod.GET]: 'get',
  [RequestMethod.POST]: 'post',
  [RequestMethod.PUT]: 'put',
  [RequestMethod.DELETE]: 'delete',
  [RequestMethod.PATCH]: 'patch',
};

export interface Route {
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

export function collectRoutes(app: INestApplication): Route[] {
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
        for (const g of reflector.get<Array<{ name?: string }>>(GUARDS_METADATA, t as never) ??
          []) {
          guards.add(typeof g === 'function' ? (g as { name: string }).name : 'anonymous');
        }
      }
      const roles = (reflector.getAllAndMerge<string[]>('roles', [handler, metatype]) ?? []).filter(
        (r): r is Role => (ROLES as readonly string[]).includes(r),
      );
      for (const cp of asArray(Reflect.getMetadata(PATH_METADATA, metatype))) {
        for (const hp of asArray(Reflect.getMetadata(PATH_METADATA, handler))) {
          const bare = pathJoin(cp, hp);
          const path =
            httpMethod === 'get' && bare === '/metrics' ? bare : pathJoin('api/v1', cp, hp);
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

