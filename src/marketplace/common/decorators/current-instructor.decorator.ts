import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import type { UserRequest } from '../../../common/interfaces/user-request.interface';
import type { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';

/**
 * The calling instructor's own capability row, attached by
 * `ApprovedInstructorGuard`. Every course/curriculum service takes
 * `MarketplaceInstructor.id` (not `users.id`) as its ownership key, so
 * controllers pull it from here rather than re-deriving it from `@GetUser()`.
 */
export const CurrentInstructor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): MarketplaceInstructor => {
    const request = ctx.switchToHttp().getRequest<UserRequest & { marketplaceInstructor: MarketplaceInstructor }>();
    return request.marketplaceInstructor;
  },
);
