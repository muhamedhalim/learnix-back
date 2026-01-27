import type { ExecutionContext } from '@nestjs/common';
import { createParamDecorator } from '@nestjs/common';

import type { JwtPayload } from '../interfaces/user-request.interface';

/**
 * Custom decorator to extract the current user from the request
 * Works with both HybridAuthGuard and standard JWT auth
 *
 * Usage:
 * @Get('profile')
 * @UseGuards(HybridAuthGuard)
 * getProfile(@GetUser() user: JwtPayload) {
 *   return user;
 * }
 */
export const GetUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const request = ctx.switchToHttp().getRequest<{ user: JwtPayload }>();
    return request.user;
  },
);
