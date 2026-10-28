import { ArrayNotEmpty, IsArray, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/** FR-066: rejection reasons plus optional structured per-item notes (readiness-checklist keys → free text). */
export class RejectCourseDto {
  @IsArray()
  // FR-066: at least one reason. An empty list passed `@IsArray` and rejected a course with no explanation.
  @ArrayNotEmpty()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  reasons!: string[];

  @IsOptional()
  @IsObject()
  item_notes?: Record<string, unknown>;
}
