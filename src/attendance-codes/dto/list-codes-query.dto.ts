import { IntersectionType } from '@nestjs/swagger';

import { PaginationDto } from '../../common/dto/pagination.dto';
import { CodeSelectionDto } from './code-selection.dto';

/**
 * Advanced filtering for the admin codes table: by batch, teacher (creator),
 * lesson/course/book (type + item), date range, lifecycle status and search —
 * plus pagination. Selection fields come from {@link CodeSelectionDto} so the
 * export flow reuses exactly the same filter contract.
 */
export class ListCodesQueryDto extends IntersectionType(PaginationDto, CodeSelectionDto) {}
