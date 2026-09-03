import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { biBody } from '../../../i18n/error-translator.util';
import { UserRequest } from '../../../common/interfaces/user-request.interface';
import { MarketplaceInstructorStatus } from '../enums';
import { MarketplaceInstructor } from '../../instructors/entities/marketplace-instructor.entity';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Instructor authority is the existence of an approved (or suspended)
 * `marketplace_instructors` row — never `user.role` (Q2, FR-009, FR-302).
 * A suspended instructor keeps read access to their own historical records
 * but is refused on any write (FR-301). Attaches the resolved capability
 * row to `request.marketplaceInstructor` so handlers don't re-query it.
 */
@Injectable()
export class ApprovedInstructorGuard implements CanActivate {
  constructor(
    @InjectRepository(MarketplaceInstructor)
    private readonly instructors: Repository<MarketplaceInstructor>,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<
      UserRequest & { marketplaceInstructor?: MarketplaceInstructor }
    >();
    const userId = request.user?.userId;
    if (!userId) {
      throw new ForbiddenException(biBody('Instructor capability is required', 'صلاحية المدرّب مطلوبة'));
    }

    const instructor = await this.instructors.findOne({ where: { user_id: userId } });
    if (!instructor || instructor.status === MarketplaceInstructorStatus.WITHDRAWN) {
      throw new ForbiddenException(biBody('Instructor capability is required', 'صلاحية المدرّب مطلوبة'));
    }

    if (
      instructor.status === MarketplaceInstructorStatus.SUSPENDED &&
      !SAFE_METHODS.has(request.method.toUpperCase())
    ) {
      throw new ForbiddenException(
        biBody(
          'Your instructor account is suspended and cannot make changes',
          'حساب المدرّب الخاص بك موقوف ولا يمكنه إجراء تغييرات',
        ),
      );
    }

    request.marketplaceInstructor = instructor;
    return true;
  }
}
