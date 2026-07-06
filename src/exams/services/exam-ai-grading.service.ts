import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { ExamAttemptAnswer, ExamQuestion } from '../entities';

/** Words ignored when comparing an essay to its model answer. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were', 'be',
  'that', 'this', 'it', 'as', 'for', 'on', 'at', 'by', 'with', 'from', 'its',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/**
 * Baseline AI-assisted grading provider. Produces an ADVISORY suggested score +
 * confidence for a manual (essay) answer by comparing the student's text to the
 * model answer (keyword coverage). It never sets the final score — a teacher
 * always accepts or overrides. A future LLM-backed provider can replace this
 * implementation behind the same method without touching the queue/worker.
 */
@Injectable()
export class ExamAiGradingService {
  private readonly logger = new Logger(ExamAiGradingService.name);

  constructor(
    @InjectRepository(ExamAttemptAnswer)
    private readonly answers: Repository<ExamAttemptAnswer>,
    @InjectRepository(ExamQuestion)
    private readonly examQuestions: Repository<ExamQuestion>,
  ) {}

  /** Compute and persist an advisory suggestion for one manual answer. */
  public async generateSuggestion(answerId: string): Promise<void> {
    const answer = await this.answers.findOne({ where: { id: answerId } });
    if (!answer || !answer.manual_required) return;

    const examQuestion = await this.examQuestions.findOne({
      where: { id: answer.exam_question_id },
    });
    if (!examQuestion) return;

    const studentText =
      typeof answer.response?.['text'] === 'string' ? (answer.response['text'] as string) : '';
    const modelAnswer = this.extractModelAnswer(examQuestion.answer_key_snapshot);

    const { fraction, confidence } = this.score(studentText, modelAnswer);
    const suggested = Math.round(fraction * answer.max_score * 100) / 100;

    await this.answers.update(answerId, {
      ai_suggested_score: suggested,
      ai_confidence: confidence,
    });
    this.logger.log(
      `AI suggestion for answer ${answerId}: ${String(suggested)}/${String(answer.max_score)} (confidence ${String(confidence)})`,
    );
  }

  private extractModelAnswer(answerKey: Record<string, unknown>): string {
    const model = answerKey['modelAnswer'];
    if (model !== null && typeof model === 'object' && 'en' in model) {
      const en = (model as { en?: unknown }).en;
      if (typeof en === 'string') return en;
    }
    return '';
  }

  private score(studentText: string, modelAnswer: string): { fraction: number; confidence: number } {
    if (studentText.trim() === '') return { fraction: 0, confidence: 0.6 };
    if (modelAnswer.trim() === '') {
      // No model answer to compare against → very low confidence, neutral guess.
      return { fraction: 0.5, confidence: 0.2 };
    }
    const studentTokens = tokenize(studentText);
    const modelTokens = tokenize(modelAnswer);
    if (modelTokens.size === 0) return { fraction: 0.5, confidence: 0.2 };

    let overlap = 0;
    for (const token of modelTokens) if (studentTokens.has(token)) overlap++;
    const fraction = Math.max(0, Math.min(1, overlap / modelTokens.size));
    // Confidence grows with how much signal we had to work with.
    const confidence = Math.min(0.75, 0.4 + Math.min(modelTokens.size, 20) / 40);
    return { fraction, confidence: Math.round(confidence * 100) / 100 };
  }
}
