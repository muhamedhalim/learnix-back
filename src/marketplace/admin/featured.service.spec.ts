import { NotFoundException } from '@nestjs/common';

import { MarketplaceCourseStatus } from '../common/enums';
import { FeaturedCourseService } from './featured.service';

function buildCourse(overrides: Record<string, unknown> = {}) {
  return {
    id: 'course-1',
    status: MarketplaceCourseStatus.PUBLISHED,
    featured_at: null,
    ...overrides,
  };
}

describe('FeaturedCourseService (T191, FR-284)', () => {
  let courses: { findOne: jest.Mock; save: jest.Mock; find: jest.Mock };
  let service: FeaturedCourseService;

  beforeEach(() => {
    courses = {
      findOne: jest.fn(),
      save: jest.fn(async (course: Record<string, unknown>) => course),
      find: jest.fn(),
    };
    service = new FeaturedCourseService(courses as never);
  });

  it('404s a course that does not exist', async () => {
    courses.findOne.mockResolvedValue(null);
    await expect(service.setFeatured('missing', true)).rejects.toThrow(NotFoundException);
  });

  it('features a published course, stamping featured_at', async () => {
    courses.findOne.mockResolvedValue(buildCourse());
    const result = await service.setFeatured('course-1', true);
    expect(result.featured_at).toBeInstanceOf(Date);
  });

  it('refuses to feature a non-published course', async () => {
    courses.findOne.mockResolvedValue(buildCourse({ status: MarketplaceCourseStatus.DRAFT }));
    await expect(service.setFeatured('course-1', true)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COURSE_NOT_FEATURABLE' }),
    });
    expect(courses.save).not.toHaveBeenCalled();
  });

  it('unfeatures regardless of current status', async () => {
    courses.findOne.mockResolvedValue(buildCourse({ status: MarketplaceCourseStatus.UNPUBLISHED, featured_at: new Date() }));
    const result = await service.setFeatured('course-1', false);
    expect(result.featured_at).toBeNull();
  });

  it('lists the featured set most-recently-promoted first', async () => {
    courses.find.mockResolvedValue([buildCourse()]);
    const result = await service.listFeatured();
    expect(courses.find).toHaveBeenCalledWith(
      expect.objectContaining({ order: { featured_at: 'DESC' } }),
    );
    expect(result).toHaveLength(1);
  });
});
