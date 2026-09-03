import { IsArray, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

/** FR-066: rejection reasons plus optional structured per-item notes (readiness-checklist keys → free text). */
export class RejectCourseDto {
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  reasons!: string[];

  @IsOptional()
  @IsObject()
  item_notes?: Record<string, unknown>;
}
