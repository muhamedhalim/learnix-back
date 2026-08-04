import { SetMetadata } from '@nestjs/common';

import type { FinancePermission } from '../finance-permissions';

export const FINANCE_PERMISSIONS_KEY = 'finance_permissions';

/**
 * Require finance capabilities for a handler, or for every handler on a
 * controller when applied to the class.
 *
 * `FinancePermissionsGuard` resolves this with `getAllAndOverride`, so a
 * handler-level decorator *replaces* the class-level default rather than adding
 * to it — state the full requirement on any handler that overrides.
 */
export const FinancePermissions = (
  ...permissions: FinancePermission[]
): MethodDecorator & ClassDecorator => SetMetadata(FINANCE_PERMISSIONS_KEY, permissions);
