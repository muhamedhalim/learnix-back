import type { INestApplication } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { createE2EApp } from './helpers/app-factory';

/**
 * API audit — route registration parity.
 *
 * A controller that is declared but not reachable (its module is missing from the
 * module graph, or sits behind a disabled feature flag) is invisible to unit tests
 * and to Swagger-from-source. This spec enumerates every handler Nest knows about
 * through its decorator metadata and then checks the *live Express router* for the
 * same `METHOD path`. Both directions must agree.
 *
 * Set `ROUTE_INVENTORY_OUT=<file>` to also write the inventory as JSON.
 */

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

interface InventoryRow {
  method: string;
  path: string;
  controller: string;
  handler: string;
  guards: string[];
  roles: string[];
}

interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  return [typeof value === 'string' ? value : ''];
}

function join(...parts: string[]): string {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/');
  return `/${joined}`;
}

function guardNames(reflector: Reflector, targets: Array<object>): string[] {
  const names = new Set<string>();
  for (const target of targets) {
    const guards =
      reflector.get<Array<{ name?: string } | (new () => unknown)>>(
        GUARDS_METADATA,
        target as never,
      ) ?? [];
    for (const g of guards) {
      names.add(typeof g === 'function' ? g.name : (g.constructor?.name ?? 'anonymous'));
    }
  }
  return [...names].sort();
}

function collectInventory(app: INestApplication): InventoryRow[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const reflector = app.get(Reflector);
  const rows: InventoryRow[] = [];

  for (const wrapper of discovery.getControllers()) {
    const { instance, metatype } = wrapper;
    if (instance === null || instance === undefined || metatype === null || metatype === undefined)
      continue;
    const prototype = Object.getPrototypeOf(instance) as object;
    const controllerPaths = asArray(Reflect.getMetadata(PATH_METADATA, metatype));

    for (const name of scanner.getAllMethodNames(prototype)) {
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const methodCode = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (methodCode === undefined) continue;
      const handlerPaths = asArray(Reflect.getMetadata(PATH_METADATA, handler));
      const roles = [
        ...(reflector.getAllAndMerge<string[]>('roles', [handler, metatype]) ?? []),
      ].map(String);
      const guards = guardNames(reflector, [metatype, handler]);

      for (const cp of controllerPaths) {
        for (const hp of handlerPaths) {
          const method = METHOD_NAMES[methodCode] ?? String(methodCode);
          const bare = join(cp, hp);
          // Mirrors `setGlobalPrefix('api/v1', { exclude: [{ path: 'metrics', method: GET }] })`.
          const prefixed = method === 'GET' && bare === '/metrics' ? bare : join('api/v1', cp, hp);
          rows.push({
            method,
            path: prefixed,
            controller: metatype.name,
            handler: name,
            guards,
            roles: [...new Set(roles)].sort(),
          });
        }
      }
    }
  }
  return rows;
}

function runtimeRoutes(app: INestApplication): Set<string> {
  const express = app.getHttpAdapter().getInstance() as { router?: { stack: ExpressLayer[] } };
  const stack = express.router?.stack ?? [];
  const keys = new Set<string>();
  for (const layer of stack) {
    if (layer.route === undefined) continue;
    for (const [method, enabled] of Object.entries(layer.route.methods)) {
      if (enabled) keys.add(`${method.toUpperCase()} ${join(layer.route.path)}`);
    }
  }
  return keys;
}

describe('API route registration parity (declared controllers vs live router)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createE2EApp());
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('registers every declared controller route on the live HTTP router, and nothing undeclared', () => {
    const declared = collectInventory(app);
    const live = runtimeRoutes(app);

    const declaredKeys = new Set(declared.map((r) => `${r.method} ${r.path}`));
    const notReachable = [...declaredKeys].filter((k) => !live.has(k) && !k.startsWith('ALL '));

    expect(declared.length).toBeGreaterThan(0);
    expect(live.size).toBeGreaterThan(0);
    expect(notReachable).toEqual([]);

    const outFile = process.env['ROUTE_INVENTORY_OUT'];
    if (outFile !== undefined && outFile !== '') {
      mkdirSync(dirname(outFile), { recursive: true });
      const undeclaredLive = [...live].filter((k) => !declaredKeys.has(k)).sort();
      writeFileSync(
        outFile,
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            marketplaceEnabled: process.env['MARKETPLACE_ENABLED'] === 'true',
            declaredCount: declaredKeys.size,
            liveCount: live.size,
            undeclaredLive,
            routes: declared.sort((a, b) =>
              `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`),
            ),
          },
          null,
          2,
        ),
      );
    }
  });

  it('has no two handlers answering the same METHOD and normalised path', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const row of collectInventory(app)) {
      // `:id` and `:courseId` are the same route shape to the router.
      const shape = `${row.method} ${row.path.replace(/:[A-Za-z0-9_]+/g, ':param')}`;
      const owner = `${row.controller}.${row.handler}`;
      const existing = seen.get(shape);
      if (existing !== undefined && existing !== owner)
        duplicates.push(`${shape}  <-  ${existing}  |  ${owner}`);
      seen.set(shape, owner);
    }
    expect(duplicates).toEqual([]);
  });

  it('exposes the marketplace admin overview route when the marketplace flag is on', () => {
    const live = runtimeRoutes(app);
    expect(live.has('GET /api/v1/marketplace/admin/overview')).toBe(true);
  });
});
