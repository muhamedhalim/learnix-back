import { randomUUID } from 'node:crypto';

import { QuestionType } from '../entities/question-type.enum';
import {
  buildFixtureTemplate,
  renderFixtureSheet,
  rotateFixture,
  shearFixture,
  type FixtureQuestionSpec,
} from './fixtures/build-fixture';
import { FiducialMarkerOmrRecognitionProvider } from './fiducial-marker-recognition.provider';

const SPECS: FixtureQuestionSpec[] = [
  { id: 'q1', type: QuestionType.SINGLE_CHOICE, optionCount: 4 },
  { id: 'q2', type: QuestionType.SINGLE_CHOICE, optionCount: 4 },
  { id: 'q3', type: QuestionType.TRUE_FALSE },
  { id: 'q4', type: QuestionType.MULTIPLE_SELECT, optionCount: 5 },
  { id: 'q5', type: QuestionType.SINGLE_CHOICE, optionCount: 4 },
];

describe('FiducialMarkerOmrRecognitionProvider (end-to-end, via programmatic fixtures)', () => {
  jest.setTimeout(30000);
  const provider = new FiducialMarkerOmrRecognitionProvider();
  const template = buildFixtureTemplate(SPECS);
  const marks: Record<string, number[]> = { q1: [1], q2: [3], q3: [0], q4: [0, 2] }; // q5 blank

  it('derives every answer correctly from a clean, upright, well-lit scan', async () => {
    const sheetId = randomUUID();
    const image = await renderFixtureSheet({ sheetId, template, marks });

    const result = await provider.recognize({
      imageBuffer: image,
      template,
      expectedSheetId: sheetId,
    });

    expect(result.outcome).toBe('recognized');
    const byId = new Map(result.perQuestion.map((a) => [a.exam_question_id, a]));
    expect(byId.get('q1')).toMatchObject({ status: 'confident', detected: { optionId: 'opt_1' } });
    expect(byId.get('q2')).toMatchObject({ status: 'confident', detected: { optionId: 'opt_3' } });
    expect(byId.get('q3')).toMatchObject({ status: 'confident', detected: { value: true } });
    expect(byId.get('q4')).toMatchObject({ status: 'confident' });
    expect((byId.get('q4')!.detected as { optionIds: string[] }).optionIds.sort()).toEqual([
      'opt_0',
      'opt_2',
    ]);
    expect(byId.get('q5')).toMatchObject({ status: 'blank', detected: null });
  });

  it('leaves an unmarked question blank rather than guessing', async () => {
    const sheetId = randomUUID();
    const image = await renderFixtureSheet({ sheetId, template, marks: {} });
    const result = await provider.recognize({
      imageBuffer: image,
      template,
      expectedSheetId: sheetId,
    });
    expect(result.outcome).toBe('recognized');
    expect(result.perQuestion.every((a) => a.status === 'blank' && a.detected === null)).toBe(true);
  });

  it('flags two marked bubbles on an exclusive question as multiple_marks, never guessing one', async () => {
    const sheetId = randomUUID();
    const image = await renderFixtureSheet({ sheetId, template, marks: { ...marks, q1: [0, 2] } });
    const result = await provider.recognize({
      imageBuffer: image,
      template,
      expectedSheetId: sheetId,
    });
    const q1 = result.perQuestion.find((a) => a.exam_question_id === 'q1')!;
    expect(q1.status).toBe('multiple_marks');
    expect(q1.detected).toBeNull();
  });

  it('corrects a 90°-rotated photo and still recognizes every answer', async () => {
    const sheetId = randomUUID();
    const clean = await renderFixtureSheet({ sheetId, template, marks });
    const rotated = await rotateFixture(clean, 90);

    const result = await provider.recognize({
      imageBuffer: rotated,
      template,
      expectedSheetId: sheetId,
    });

    expect(result.outcome).toBe('recognized');
    expect(result.rawMeta.rotationAppliedDegrees).not.toBe(0);
    const byId = new Map(result.perQuestion.map((a) => [a.exam_question_id, a]));
    expect(byId.get('q1')).toMatchObject({ status: 'confident', detected: { optionId: 'opt_1' } });
    expect(byId.get('q5')).toMatchObject({ status: 'blank' });
  });

  it('corrects a 180°-rotated photo', async () => {
    const sheetId = randomUUID();
    const clean = await renderFixtureSheet({ sheetId, template, marks });
    const rotated = await rotateFixture(clean, 180);
    const result = await provider.recognize({
      imageBuffer: rotated,
      template,
      expectedSheetId: sheetId,
    });
    expect(result.outcome).toBe('recognized');
    expect(result.perQuestion.find((a) => a.exam_question_id === 'q2')).toMatchObject({
      status: 'confident',
      detected: { optionId: 'opt_3' },
    });
  });

  it('recovers geometry through a reasonable perspective-like (sheared) distortion', async () => {
    const sheetId = randomUUID();
    const clean = await renderFixtureSheet({ sheetId, template, marks });
    const sheared = await shearFixture(clean, 0.06);
    const result = await provider.recognize({
      imageBuffer: sheared,
      template,
      expectedSheetId: sheetId,
    });
    expect(result.outcome).toBe('recognized');
    expect(result.perQuestion.find((a) => a.exam_question_id === 'q3')).toMatchObject({
      status: 'confident',
      detected: { value: true },
    });
  });

  it('rejects a sheet whose QR identifies a different sheet (wrong template/mismatch)', async () => {
    const sheetId = randomUUID();
    const otherSheetId = randomUUID();
    const image = await renderFixtureSheet({
      sheetId,
      template,
      marks,
      qrSheetIdOverride: otherSheetId,
    });
    const result = await provider.recognize({
      imageBuffer: image,
      template,
      expectedSheetId: sheetId,
    });
    expect(result.outcome).toBe('template_mismatch');
    expect(result.perQuestion).toEqual([]);
  });

  it('rejects a malformed/corrupt image cleanly instead of throwing', async () => {
    const result = await provider.recognize({
      imageBuffer: Buffer.from('this is not an image'),
      template,
      expectedSheetId: randomUUID(),
    });
    expect(result.outcome).toBe('invalid_image');
    expect(result.errorMessage).toBeDefined();
  });

  it('still recognizes correctly when the identity QR is absent (best-effort, not a hard requirement)', async () => {
    const sheetId = randomUUID();
    const image = await renderFixtureSheet({ sheetId, template, marks, skipQr: true });
    const result = await provider.recognize({
      imageBuffer: image,
      template,
      expectedSheetId: sheetId,
    });
    expect(result.outcome).toBe('recognized');
    expect(result.rawMeta.qrDecoded).toBe(false);
    expect(result.perQuestion.find((a) => a.exam_question_id === 'q1')).toMatchObject({
      status: 'confident',
    });
  });

  it('produces per-question audit metadata (fill ratios, threshold) alongside the classification', async () => {
    const sheetId = randomUUID();
    const image = await renderFixtureSheet({ sheetId, template, marks });
    const result = await provider.recognize({
      imageBuffer: image,
      template,
      expectedSheetId: sheetId,
    });
    for (const answer of result.perQuestion) {
      expect(answer.raw.fillRatios.length).toBeGreaterThan(0);
      expect(answer.raw.threshold).toBeGreaterThan(0);
      expect(answer.confidence).toBeGreaterThanOrEqual(0);
      expect(answer.confidence).toBeLessThanOrEqual(1);
    }
  });
});
