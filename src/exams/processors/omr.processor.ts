import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';

import { Job } from 'bullmq';
import { Repository } from 'typeorm';

import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { AttemptState, ExamQuestion, OmrSheet, OmrSheetStatus } from '../entities';
import { QuestionTypeRegistry } from '../question-types/question-type-registry';
import { AttemptService } from '../services/attempt.service';

interface OmrJob {
  sheetId: string;
}

/**
 * Worker that turns a submitted OMR sheet (uploaded scan + pre-detected marks
 * — see the module doc on `OmrSheet`, this pipeline does not do image/bubble
 * detection) into a graded exam attempt. Reuses the existing attempt/grading
 * engine end to end (`AttemptService.createOmrAttempt` / `saveAnswers` /
 * `submit`) rather than re-implementing any scoring logic.
 *
 * Idempotent under BullMQ's at-least-once redelivery: a sheet already marked
 * COMPLETED is a no-op, and `createOmrAttempt` returns an existing (in
 * progress or already-finalised) attempt rather than duplicating it, so a
 * retried job never double-grades.
 */
@Processor(QUEUE_NAMES.EXAM_OMR, { concurrency: WORKER_CONFIG.concurrency })
export class OmrProcessor extends WorkerHost {
  private readonly logger = new Logger(OmrProcessor.name);

  constructor(
    @InjectRepository(OmrSheet) private readonly sheets: Repository<OmrSheet>,
    @InjectRepository(ExamQuestion) private readonly examQuestions: Repository<ExamQuestion>,
    private readonly registry: QuestionTypeRegistry,
    private readonly attemptService: AttemptService,
  ) {
    super();
  }

  public async process(job: Job<OmrJob>): Promise<void> {
    if (job.name !== JOB_TYPES.EXAM.OMR_PROCESS_SHEET) return;
    const { sheetId } = job.data;

    const sheet = await this.sheets.findOne({ where: { id: sheetId } });
    if (!sheet) {
      this.logger.warn(`OMR sheet ${sheetId} not found — skipping`);
      return;
    }
    if (sheet.status === OmrSheetStatus.COMPLETED) {
      this.logger.log(`OMR sheet ${sheetId} already completed — skipping (idempotent)`);
      return;
    }

    this.logger.log(`Processing OMR sheet ${sheetId} (exam ${sheet.exam_id}, student ${sheet.student_id})`);
    sheet.status = OmrSheetStatus.PROCESSING;
    await this.sheets.save(sheet);

    try {
      const examQuestions = await this.examQuestions.find({ where: { exam_id: sheet.exam_id } });
      const eqById = new Map(examQuestions.map((eq) => [eq.id, eq]));

      const errors: string[] = [];
      sheet.detected_answers.forEach((item, i) => {
        const eq = eqById.get(item.exam_question_id);
        if (!eq) {
          errors.push(`answers[${String(i)}]: exam_question_id ${item.exam_question_id} does not belong to this exam`);
          return;
        }
        if (item.response !== null) {
          const responseErrors = this.registry.require(eq.type_snapshot).validateResponse(item.response);
          errors.push(...responseErrors.map((e) => `answers[${String(i)}]: ${e}`));
        }
      });

      if (errors.length > 0) {
        sheet.status = OmrSheetStatus.FAILED;
        sheet.error_message = errors.join('; ');
        await this.sheets.save(sheet);
        this.logger.warn(`OMR sheet ${sheetId} failed validation: ${sheet.error_message}`);
        return; // deterministic data problem — do not consume a BullMQ retry
      }

      const attempt = await this.attemptService.createOmrAttempt(sheet.exam_id, sheet.student_id);

      if (attempt.state === AttemptState.IN_PROGRESS) {
        await this.attemptService.saveAnswers(sheet.student_id, attempt.id, {
          answers: sheet.detected_answers.map((a) => ({
            exam_question_id: a.exam_question_id,
            response: a.response,
          })),
        });
        const summary = await this.attemptService.submit(sheet.student_id, attempt.id, { answers: [] });
        this.logger.log(`OMR sheet ${sheetId} graded attempt ${attempt.id} → ${summary.state}`);
      } else {
        this.logger.log(
          `OMR sheet ${sheetId}: student already has a finalised attempt ${attempt.id} (${attempt.state}) — skipping re-grade (idempotent)`,
        );
      }

      sheet.status = OmrSheetStatus.COMPLETED;
      sheet.attempt_id = attempt.id;
      sheet.processed_at = new Date();
      sheet.error_message = null;
      await this.sheets.save(sheet);
    } catch (err) {
      sheet.status = OmrSheetStatus.FAILED;
      sheet.error_message = err instanceof Error ? err.message : 'Unknown error';
      await this.sheets.save(sheet);
      this.logger.error(
        `OMR sheet ${sheetId} processing error: ${sheet.error_message}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err; // let BullMQ retry per EXAM_OMR's configured backoff
    }
  }
}
