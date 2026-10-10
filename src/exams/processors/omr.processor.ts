import { Inject, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';

import { Job } from 'bullmq';
import { Repository } from 'typeorm';

import { streamToBuffer } from '../../common/utils/stream-to-buffer.util';
import { StorageService } from '../../storage/storage.service';
import { JOB_TYPES, QUEUE_NAMES, WORKER_CONFIG } from '../../queues/queues.constants';
import { markNeedsReview, OmrSheet, OmrSheetStatus, OmrTemplate } from '../entities';
import {
  OMR_RECOGNITION_PROVIDER,
  type OmrRecognitionProvider,
} from '../omr-recognition/omr-recognition.interface';

interface OmrJob {
  sheetId: string;
}

/**
 * Worker that turns a submitted OMR sheet's SCANNED IMAGE into detected
 * answers via `OmrRecognitionProvider` (the actual CV pipeline —
 * `omr-recognition/`). This is deliberately CV-only: it never touches the
 * Attempt/grading engine. `OmrSheetsService.confirm()` (triggered once a
 * teacher has resolved every flagged question) is what calls
 * `AttemptService` — grading only ever happens after a human has had a
 * chance to review anything uncertain, never automatically from this worker.
 *
 * Idempotent under BullMQ's at-least-once redelivery: only a `PENDING` sheet
 * with an uploaded image is processed; anything else (already
 * processing/ready/review_required/confirmed/completed/failed) is a no-op.
 */
@Processor(QUEUE_NAMES.EXAM_OMR, { concurrency: WORKER_CONFIG.concurrency, autorun: WORKER_CONFIG.autorun })
export class OmrProcessor extends WorkerHost {
  private readonly logger = new Logger(OmrProcessor.name);

  constructor(
    @InjectRepository(OmrSheet) private readonly sheets: Repository<OmrSheet>,
    @InjectRepository(OmrTemplate) private readonly templates: Repository<OmrTemplate>,
    private readonly storage: StorageService,
    @Inject(OMR_RECOGNITION_PROVIDER) private readonly recognizer: OmrRecognitionProvider,
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
    if (sheet.status !== OmrSheetStatus.PENDING) {
      this.logger.log(`OMR sheet ${sheetId} is already ${sheet.status} — skipping (idempotent)`);
      return;
    }
    if (!sheet.image_key) {
      this.logger.warn(`OMR sheet ${sheetId} has no uploaded image — skipping`);
      return;
    }

    this.logger.log(
      `Processing OMR sheet ${sheetId} (exam ${sheet.exam_id}, student ${sheet.student_id})`,
    );
    sheet.status = OmrSheetStatus.PROCESSING;
    await this.sheets.save(sheet);

    try {
      const template = sheet.template_id
        ? await this.templates.findOne({ where: { id: sheet.template_id } })
        : null;
      if (!template) {
        sheet.status = OmrSheetStatus.FAILED;
        sheet.error_message = 'No OMR template bound to this sheet';
        await this.sheets.save(sheet);
        this.logger.warn(`OMR sheet ${sheetId} failed: missing template`);
        return; // deterministic data problem — do not consume a BullMQ retry
      }

      const object = await this.storage.getObject(this.storage.toKey(sheet.image_key));
      const imageBuffer = await streamToBuffer(object.stream);

      const result = await this.recognizer.recognize({
        imageBuffer,
        template: template.layout,
        expectedSheetId: sheet.id,
      });

      if (result.outcome !== 'recognized') {
        sheet.status = OmrSheetStatus.FAILED;
        sheet.error_message = result.errorMessage ?? `Recognition failed: ${result.outcome}`;
        sheet.recognition_provider = result.rawMeta.provider;
        await this.sheets.save(sheet);
        this.logger.warn(`OMR sheet ${sheetId} failed validation: ${sheet.error_message}`);
        return; // deterministic recognition outcome — do not consume a BullMQ retry
      }

      sheet.recognized_answers = result.perQuestion;
      // Seed the confirmable draft: only genuinely confident marks are
      // filled in — anything flagged for review stays null (never guess),
      // and blank stays null (a normal, unambiguous "not answered").
      sheet.detected_answers = result.perQuestion.map((answer) => ({
        exam_question_id: answer.exam_question_id,
        response: answer.status === 'confident' ? answer.detected : null,
      }));
      sheet.recognition_provider = result.rawMeta.provider;
      sheet.status = result.perQuestion.some(markNeedsReview)
        ? OmrSheetStatus.REVIEW_REQUIRED
        : OmrSheetStatus.READY;
      sheet.error_message = null;
      sheet.processed_at = new Date();
      await this.sheets.save(sheet);
      this.logger.log(`OMR sheet ${sheetId} recognized → ${sheet.status}`);
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
