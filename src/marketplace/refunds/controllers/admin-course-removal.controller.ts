import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { Roles } from '../../../common/decorators/roles.decorator';
import { InvalidatesCache } from '../../../common/cache/cache-invalidation.decorator';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { FinancePermissions } from '../../../payments/decorators/finance-permissions.decorator';
import { FinancePermissionsGuard } from '../../../payments/guards/finance-permissions.guard';
import { CourseRemovalService } from '../../catalog/course-removal.service';
import { MarketplaceCourseRemoval } from '../../catalog/entities';
import { RemoveCourseDto } from '../dto/remove-course.dto';

/**
 * Contracts §4: `POST /marketplace/admin/courses/:id/remove` (FR-054a).
 * Lives alongside the refund controllers (not `AdminCoursesController` in
 * `catalog/controllers/`) because `CourseRemovalService` depends on the
 * refund machinery, and `CatalogModule` importing `RefundsModule` back
 * would close a cycle (`RefundsModule → CommerceModule → DiscoveryModule →
 * CatalogModule` already exists one-way). The route path is independent of
 * which module registers the controller.
 */
@ApiTags('Marketplace / Admin / Course Removal')
@Controller('marketplace/admin/courses')
@UseGuards(JwtAuthGuard, RolesGuard, FinancePermissionsGuard)
@Roles('admin')
@ApiBearerAuth('JWT-auth')
export class AdminCourseRemovalController {
  constructor(private readonly removal: CourseRemovalService) {}

  @Post(':id/remove')
  // Request path writes `marketplace_courses` (unpublish + removed_at), `marketplace_course_removals`,
  // `audit_logs` (x2) and enqueues BullMQ jobs; `admin_dashboard` reads audit logs. The per-learner refund /
  // revoke fan-out runs later in the queue processor (non-HTTP writer, TTL-bounded, unchanged) (T031).
  @InvalidatesCache(['marketplace_catalog', 'admin_dashboard'])
  @FinancePermissions('marketplace.refunds.process')
  @ApiOperation({
    summary:
      'Permanently remove a course: unpublish, revoke access, refund every paid enrollment in full (FR-054a)',
  })
  public async remove(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) courseId: string,
    @Body() dto: RemoveCourseDto,
  ): Promise<MarketplaceCourseRemoval> {
    return this.removal.removeCourse(user.userId, courseId, dto.cause, dto.reason);
  }
}
