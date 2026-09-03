import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { MarketplaceCourse } from '../catalog/entities';
import { MarketplaceCourseStatus } from '../common/enums';
import { courseNotFeaturable } from '../common/errors';

/**
 * FR-284 (T191). No public marketplace filter is added for this — contracts
 * §1's `GET /marketplace/courses` query parameter list (already fixed by
 * this feature's contracts) has no `featured` entry, so "the featured set
 * MUST be visible" is satisfied by an admin being able to see and edit it
 * here; adding a new public-facing filter would be scope beyond what's
 * specified.
 */
@Injectable()
export class FeaturedCourseService {
  constructor(
    @InjectRepository(MarketplaceCourse)
    private readonly courses: Repository<MarketplaceCourse>,
  ) {}

  /** Toggles one course's membership in the featured set. Only a currently-published course can be added; removal is always allowed. */
  public async setFeatured(courseId: string, featured: boolean): Promise<MarketplaceCourse> {
    const course = await this.courses.findOne({ where: { id: courseId } });
    if (!course) {
      throw new NotFoundException(biBody('Course not found', 'الدورة غير موجودة'));
    }
    if (featured && course.status !== MarketplaceCourseStatus.PUBLISHED) {
      throw courseNotFeaturable();
    }
    course.featured_at = featured ? new Date() : null;
    return this.courses.save(course);
  }

  /** The current featured set, most-recently-promoted first. */
  public async listFeatured(): Promise<MarketplaceCourse[]> {
    return this.courses.find({ where: { featured_at: Not(IsNull()) }, order: { featured_at: 'DESC' } });
  }
}
