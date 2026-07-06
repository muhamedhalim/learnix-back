import { BadRequestException, Injectable } from '@nestjs/common';

import { QuestionType } from '../entities';
import { ALL_QUESTION_TYPE_DEFINITIONS } from './definitions';
import { QuestionTypeDefinition } from './question-type-definition.interface';

/**
 * Central registry of question-type definitions. Injected wherever a question
 * needs to be validated or graded, so no service ever branches on the concrete
 * question type — it asks the registry for the definition and delegates.
 */
@Injectable()
export class QuestionTypeRegistry {
  private readonly definitions = new Map<QuestionType, QuestionTypeDefinition>();

  constructor() {
    for (const definition of ALL_QUESTION_TYPE_DEFINITIONS) {
      this.definitions.set(definition.type, definition);
    }
  }

  /** Whether a definition is registered for the given type. */
  public has(type: QuestionType): boolean {
    return this.definitions.has(type);
  }

  /**
   * Get the definition for a type, or throw a 400 if it is not supported. Use
   * this on all request-driven paths so an unsupported type is a clean client
   * error rather than an internal crash.
   */
  public require(type: QuestionType): QuestionTypeDefinition {
    const definition = this.definitions.get(type);
    if (!definition) {
      throw new BadRequestException(`Unsupported question type: ${String(type)}`);
    }
    return definition;
  }

  /** All registered definitions (e.g. for capability listing). */
  public list(): QuestionTypeDefinition[] {
    return [...this.definitions.values()];
  }
}
