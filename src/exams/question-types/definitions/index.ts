import { QuestionTypeDefinition } from '../question-type-definition.interface';
import { essayDefinition } from './essay.definition';
import { fillBlankDefinition } from './fill-blank.definition';
import { multipleSelectDefinition } from './multiple-select.definition';
import { numericDefinition } from './numeric.definition';
import { singleChoiceDefinition } from './single-choice.definition';
import { trueFalseDefinition } from './true-false.definition';

/**
 * The complete set of registered question types. Adding a new type = implement a
 * definition and add it to this array. Nothing else in the system changes.
 */
export const ALL_QUESTION_TYPE_DEFINITIONS: readonly QuestionTypeDefinition[] = [
  singleChoiceDefinition,
  multipleSelectDefinition,
  trueFalseDefinition,
  fillBlankDefinition,
  numericDefinition,
  essayDefinition,
];

export {
  singleChoiceDefinition,
  multipleSelectDefinition,
  trueFalseDefinition,
  fillBlankDefinition,
  numericDefinition,
  essayDefinition,
};
