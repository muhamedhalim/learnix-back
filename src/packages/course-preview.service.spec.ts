import { NotFoundException } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { Lesson } from '../lessons/entities/lesson.entity';
import { MediaService } from '../media/media.service';
import { PackagePurchase } from '../payments/entities/package-purchase.entity';
import { ReviewsService } from '../reviews/reviews.service';
import { TeacherProfile } from '../teachers/entities/teacher-profile.entity';
import { CoursePreviewService } from './course-preview.service';
import { CourseChapter } from './entities/course-chapter.entity';
import { LessonPackage } from './entities/lesson-package.entity';
import { LessonPackageItem } from './entities/lesson-package-item.entity';

describe('CoursePreviewService.getPreview', () => {
  let service: CoursePreviewService;

  const packages = { findOne: jest.fn(), createQueryBuilder: jest.fn() };
  const items = { find: jest.fn() };
  const chapters = { find: jest.fn() };
  const lessons = { find: jest.fn() };
  const teacherProfiles = { findOne: jest.fn() };
  const purchases = { count: jest.fn() };
  const reviews = { getPackageAggregates: jest.fn() };
  const media = { resolveThumbnailUrl: jest.fn().mockReturnValue(null) };
  const applicationCache = {
    getOrCompute: jest.fn(
      async (_descriptor: unknown, compute: () => Promise<unknown>) => await compute(),
    ),
  };

  const relatedQb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    applicationCache.getOrCompute.mockImplementation(
      async (_descriptor: unknown, compute: () => Promise<unknown>) => await compute(),
    );
    packages.createQueryBuilder.mockReturnValue(relatedQb);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoursePreviewService,
        { provide: getRepositoryToken(LessonPackage), useValue: packages },
        { provide: getRepositoryToken(LessonPackageItem), useValue: items },
        { provide: getRepositoryToken(CourseChapter), useValue: chapters },
        { provide: getRepositoryToken(Lesson), useValue: lessons },
        { provide: getRepositoryToken(TeacherProfile), useValue: teacherProfiles },
        { provide: getRepositoryToken(PackagePurchase), useValue: purchases },
        { provide: ReviewsService, useValue: reviews },
        { provide: MediaService, useValue: media },
        { provide: ApplicationCacheService, useValue: applicationCache },
      ],
    }).compile();
    service = module.get(CoursePreviewService);
  });

  it('404s for an unpublished / missing course', async () => {
    packages.findOne.mockResolvedValue(null);
    await expect(service.getPreview('P1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('exposes video only for free-preview lessons and locks the rest', async () => {
    packages.findOne.mockResolvedValue({
      id: 'P1',
      teacher_id: 'T1',
      teacher: { name: 'Prof X', profile_picture_url: null },
      title: 'Course',
      title_ar: '',
      description: null,
      description_ar: null,
      thumbnail: null,
      intro_video_url: null,
      price: '50',
      original_price: null,
      category: null,
      tags: null,
      requirements: null,
      what_you_learn: null,
      faq: null,
      updated_at: new Date(),
    });
    teacherProfiles.findOne.mockResolvedValue({ bio: 'Hi', years_of_experience: 3 });
    chapters.find.mockResolvedValue([]);
    items.find.mockResolvedValue([
      { lesson_id: 'L1', chapter_id: null, order_index: 0 },
      { lesson_id: 'L2', chapter_id: null, order_index: 1 },
    ]);
    lessons.find.mockResolvedValue([
      {
        id: 'L1',
        title: 'Free intro',
        duration: 60,
        is_free_preview: true,
        video_asset_id: 'asset-1',
        video_status: 'ready',
      },
      {
        id: 'L2',
        title: 'Paid lesson',
        duration: 120,
        is_free_preview: false,
        video_asset_id: 'asset-2',
        video_status: 'ready',
      },
    ]);
    reviews.getPackageAggregates.mockResolvedValue({
      average_rating: 4,
      total_reviews: 2,
      rating_distribution: { 1: 0, 2: 0, 3: 0, 4: 2, 5: 0 },
    });
    purchases.count.mockResolvedValue(5);

    const result = (await service.getPreview('P1')) as {
      lessons_count: number;
      students_count: number;
      curriculum: { lessons: { id: string; locked: boolean; video: unknown }[] }[];
    };

    expect(result.students_count).toBe(5);
    expect(result.lessons_count).toBe(2);
    const flat = result.curriculum.flatMap((s) => s.lessons);
    const free = flat.find((l) => l.id === 'L1')!;
    const locked = flat.find((l) => l.id === 'L2')!;
    expect(free.locked).toBe(false);
    expect(free.video).not.toBeNull();
    // The unauthenticated preview only names the lesson; the grant comes from the playback route.
    expect(free.video).toEqual({ platform: 'aws', lesson_id: 'L1' });
    // ...and never leaks storage identifiers.
    expect(JSON.stringify(free.video)).not.toMatch(/video_asset_id|asset-1/);
    expect(locked.locked).toBe(true);
    expect(locked.video).toBeNull();
  });

  describe('caching (T037 a)', () => {
    it('caches under public_catalog/public, keyed by package id, 60 s TTL', async () => {
      packages.findOne.mockResolvedValue(null);
      await expect(service.getPreview('P1')).rejects.toBeInstanceOf(NotFoundException);

      expect(applicationCache.getOrCompute).toHaveBeenCalledWith(
        {
          family: 'public_catalog',
          endpoint: 'packages.preview',
          scope: 'public',
          parts: ['P1'],
          ttlMs: 60_000,
        },
        expect.any(Function),
      );
    });

    it('the cached value itself carries no grant or expiry (only the lesson id of a playable free preview)', async () => {
      const cachedValue = {
        id: 'P1',
        curriculum: [
          {
            chapter: null,
            lessons: [
              {
                id: 'L1',
                title: 'Free',
                duration: 60,
                is_free_preview: true,
                locked: false,
                aws_playback_lesson_id: 'L1',
              },
            ],
          },
        ],
      };
      expect(JSON.stringify(cachedValue)).not.toMatch(/signed_url|expires_in/);

      applicationCache.getOrCompute.mockResolvedValue(cachedValue);
      const result = (await service.getPreview('P1')) as {
        curriculum: { lessons: { video: { platform: 'aws'; lesson_id: string } | null }[] }[];
      };

      expect(result.curriculum[0]!.lessons[0]!.video).toEqual({ platform: 'aws', lesson_id: 'L1' });
      // The raw cached shape (as stored) is never re-exposed with the marker still on it.
      expect(JSON.stringify(result)).not.toContain('aws_playback_lesson_id');
    });

    it('a hit runs no database query at all', async () => {
      applicationCache.getOrCompute.mockResolvedValue({ id: 'P1', curriculum: [] });

      await service.getPreview('P1');

      expect(packages.findOne).not.toHaveBeenCalled();
    });

    it('a 404 is never cached: computePreview throws before getOrCompute can store anything', async () => {
      packages.findOne.mockResolvedValue(null);

      await expect(service.getPreview('missing')).rejects.toBeInstanceOf(NotFoundException);

      // getOrCompute was invoked (it owns the try/store), but its own compute callback is what threw.
      expect(applicationCache.getOrCompute).toHaveBeenCalledTimes(1);
    });
  });
});
