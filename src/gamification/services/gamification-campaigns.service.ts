import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { biBody } from '../../i18n/error-translator.util';
import { Lesson } from '../../lessons/entities/lesson.entity';
import { CreateGamificationCampaignDto, UpdateGamificationCampaignDto } from '../dto/gamification-campaign.dto';
import { GamificationCampaign } from '../entities/gamification-campaign.entity';

/**
 * DEF-018: teacher-scoped XP bonus campaigns, strictly limited to lessons
 * the acting teacher owns. Uses the same `assertOwned`-style pattern as
 * `OmrSheetsService`/other teacher-scoped services elsewhere in the backend:
 * a 404 (not 403) on a non-owned lesson, so ownership is never disclosed.
 */
@Injectable()
export class GamificationCampaignsService {
  constructor(
    @InjectRepository(GamificationCampaign)
    private readonly campaigns: Repository<GamificationCampaign>,
    @InjectRepository(Lesson)
    private readonly lessons: Repository<Lesson>,
  ) {}

  public async listForTeacher(teacherId: string): Promise<GamificationCampaign[]> {
    return this.campaigns.find({ where: { teacher_id: teacherId }, order: { created_at: 'DESC' } });
  }

  public async createForTeacher(
    teacherId: string,
    dto: CreateGamificationCampaignDto,
  ): Promise<GamificationCampaign> {
    await this.assertLessonOwned(dto.lesson_id, teacherId);
    const startAt = dto.start_at ? new Date(dto.start_at) : new Date();
    const endAt = dto.end_at ? new Date(dto.end_at) : null;
    this.assertValidWindow(startAt, endAt);
    return this.campaigns.save(
      this.campaigns.create({
        teacher_id: teacherId,
        lesson_id: dto.lesson_id,
        title: dto.title.trim(),
        bonus_xp: dto.bonus_xp,
        enabled: true,
        start_at: startAt,
        end_at: endAt,
      }),
    );
  }

  public async update(
    teacherId: string,
    campaignId: string,
    dto: UpdateGamificationCampaignDto,
  ): Promise<GamificationCampaign> {
    const campaign = await this.campaigns.findOne({ where: { id: campaignId, teacher_id: teacherId } });
    if (!campaign) {
      throw new NotFoundException(biBody('Campaign not found', 'الحملة غير موجودة'));
    }
    if (dto.title !== undefined) campaign.title = dto.title.trim();
    if (dto.bonus_xp !== undefined) campaign.bonus_xp = dto.bonus_xp;
    if (dto.enabled !== undefined) campaign.enabled = dto.enabled;
    if (dto.start_at !== undefined) campaign.start_at = new Date(dto.start_at);
    if (dto.end_at !== undefined) campaign.end_at = dto.end_at ? new Date(dto.end_at) : null;
    this.assertValidWindow(campaign.start_at, campaign.end_at);
    return this.campaigns.save(campaign);
  }

  /**
   * The one enabled, in-window campaign for this lesson at time `at`, or
   * null. Called from inside `GamificationService.recordSolve`'s
   * transaction — pass that transaction's `manager` so the read is part of
   * the same atomic unit as the award it feeds into.
   */
  public async activeForLesson(
    lessonId: string,
    at: Date,
    manager?: EntityManager,
  ): Promise<GamificationCampaign | null> {
    const repo = manager ? manager.getRepository(GamificationCampaign) : this.campaigns;
    return repo
      .createQueryBuilder('campaign')
      .where('campaign.lesson_id = :lessonId', { lessonId })
      .andWhere('campaign.enabled = true')
      .andWhere('campaign.start_at <= :at', { at })
      .andWhere('(campaign.end_at IS NULL OR campaign.end_at > :at)', { at })
      .getOne();
  }

  private async assertLessonOwned(lessonId: string, teacherId: string): Promise<void> {
    const lesson = await this.lessons.findOne({ where: { id: lessonId, teacher_id: teacherId } });
    if (!lesson) {
      throw new NotFoundException(biBody('Lesson not found', 'الدرس غير موجود'));
    }
  }

  private assertValidWindow(startAt: Date, endAt: Date | null): void {
    if (endAt && endAt <= startAt) {
      throw new BadRequestException(
        biBody('End date must be after the start date', 'يجب أن يكون تاريخ الانتهاء بعد تاريخ البدء'),
      );
    }
  }
}
