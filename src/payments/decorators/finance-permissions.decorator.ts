import { SetMetadata } from '@nestjs/common';

import type { FinancePermission } from '../finance-permissions';

export const FINANCE_PERMISSIONS_KEY = 'finance_permissions';

export const FinancePermissions = (...permissions: FinancePermission[]): MethodDecorator =>
  SetMetadata(FINANCE_PERMISSIONS_KEY, permissions);
