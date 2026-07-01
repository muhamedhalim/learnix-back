import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import {
  CreateAttachmentDto,
  CreateHomeworkDto,
  UpdateHomeworkDto,
} from './dto';
import { Lesson } from './entities/lesson.entity';
import { LessonAttachment } from './entities/lesson-attachment.entity';
import { LessonHomework } from './entities/lesson-homework.entity';

@Injectable()
export class LessonContentService {
  constructor(
    @InjectRepository(Lesson)
    private readonly lessonsRepository: Repository<Lesson>,
    @InjectRepository(LessonAttachment)
    private readonly attachmentsRepository: Repository<LessonAttachment>,
    @InjectRepository(LessonHomework)
    private readonly homeworkRepository: Repository<LessonHomework>,
  ) {}

  private async assertOwnedLesson(
    lessonId: string,
    teacherId: string,
  ): Promise<void> {
    const lesson = await this.lessonsRepository.findOne({
      where: { id: lessonId },
    });
    if (!lesson) {
      throw new NotFoundException(`Lesson with ID ${lessonId} not found`);
    }
    if (lesson.teacher_id !== teacherId) {
      throw new ForbiddenException('You can only manage your own lessons');
    }
  }

  /* ===================== Attachments ===================== */

  public async listAttachments(
    lessonId: string,
    teacherId: string,
  ): Promise<LessonAttachment[]> {
    await this.assertOwnedLesson(lessonId, teacherId);
    return this.attachmentsRepository.find({
      where: { lesson_id: lessonId },
      order: { created_at: 'ASC' },
    });
  }

  public async addAttachment(
    lessonId: string,
    teacherId: string,
    dto: CreateAttachmentDto,
  ): Promise<LessonAttachment> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const attachment = this.attachmentsRepository.create({
      lesson_id: lessonId,
      name: dto.name,
      url: dto.url,
      type: dto.type ?? 'other',
      size_bytes: dto.size_bytes ?? null,
    });
    return this.attachmentsRepository.save(attachment);
  }

  public async deleteAttachment(
    lessonId: string,
    attachmentId: string,
    teacherId: string,
  ): Promise<void> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const attachment = await this.attachmentsRepository.findOne({
      where: { id: attachmentId, lesson_id: lessonId },
    });
    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }
    await this.attachmentsRepository.remove(attachment);
  }

  /* ===================== Homework ===================== */

  public async listHomework(
    lessonId: string,
    teacherId: string,
  ): Promise<LessonHomework[]> {
    await this.assertOwnedLesson(lessonId, teacherId);
    return this.homeworkRepository.find({
      where: { lesson_id: lessonId },
      order: { created_at: 'ASC' },
    });
  }

  public async addHomework(
    lessonId: string,
    teacherId: string,
    dto: CreateHomeworkDto,
  ): Promise<LessonHomework> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = this.homeworkRepository.create({
      lesson_id: lessonId,
      title: dto.title,
      description: dto.description ?? null,
      type: dto.type ?? 'text',
      resource_url: dto.resource_url ?? null,
      due_at: dto.due_at ? new Date(dto.due_at) : null,
    });
    return this.homeworkRepository.save(homework);
  }

  public async updateHomework(
    lessonId: string,
    homeworkId: string,
    teacherId: string,
    dto: UpdateHomeworkDto,
  ): Promise<LessonHomework> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = await this.homeworkRepository.findOne({
      where: { id: homeworkId, lesson_id: lessonId },
    });
    if (!homework) {
      throw new NotFoundException('Homework not found');
    }
    if (dto.title !== undefined) homework.title = dto.title;
    if (dto.description !== undefined) homework.description = dto.description;
    if (dto.type !== undefined) homework.type = dto.type;
    if (dto.resource_url !== undefined) homework.resource_url = dto.resource_url;
    if (dto.due_at !== undefined) {
      homework.due_at = dto.due_at ? new Date(dto.due_at) : null;
    }
    return this.homeworkRepository.save(homework);
  }

  public async deleteHomework(
    lessonId: string,
    homeworkId: string,
    teacherId: string,
  ): Promise<void> {
    await this.assertOwnedLesson(lessonId, teacherId);
    const homework = await this.homeworkRepository.findOne({
      where: { id: homeworkId, lesson_id: lessonId },
    });
    if (!homework) {
      throw new NotFoundException('Homework not found');
    }
    await this.homeworkRepository.softRemove(homework);
  }
}
