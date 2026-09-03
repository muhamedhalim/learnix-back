/** FR-133. Only `PLATFORM` is exposed in this feature; the others are reserved. */
export enum MarketplaceCommissionScope {
  PLATFORM = 'platform',
  INSTRUCTOR = 'instructor',
  COURSE = 'course',
  CATEGORY = 'category',
}
