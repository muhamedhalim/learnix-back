import { ArrayMinSize } from 'class-validator';

import { bi } from '../../i18n/error-translator.util';

export class RemoveLessonsDto {
  @ArrayMinSize(1, {
    message: bi('At least one lesson ID is required', 'يلزم معرف درس واحد على الأقل'),
  })
  public lessonIds!: string[];
}
