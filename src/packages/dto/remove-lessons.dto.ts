import { ArrayMinSize } from 'class-validator';

export class RemoveLessonsDto {
  @ArrayMinSize(1, { message: 'At least one lesson ID is required' })
  public lessonIds!: string[];
}
