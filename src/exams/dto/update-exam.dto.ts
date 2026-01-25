import { PartialType } from '@nestjs/swagger';

import { CreateExamDto } from './create-exam.dto';

/**
 * Update exam DTO
 * All fields are optional for partial updates
 *
 * Note: Updates are blocked if the exam has any submissions
 */
export class UpdateExamDto extends PartialType(CreateExamDto) {}
