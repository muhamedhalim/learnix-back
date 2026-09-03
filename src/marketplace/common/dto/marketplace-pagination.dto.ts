import { Pagination20Dto } from '../../../common/dto/pagination.dto';

/**
 * Every marketplace list endpoint's pagination contract (FR-077, FR-281):
 * default page size 20, maximum 100. `Pagination20Dto`'s existing
 * `@Max(100)` already **refuses** a request above the maximum rather than
 * clamping it — exactly what FR-077 requires — so this is a re-export
 * under a marketplace-local name, not a reimplementation.
 */
export class MarketplaceListQueryDto extends Pagination20Dto {}
