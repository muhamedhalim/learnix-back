export interface RevenuePeriodBoundaries {
  startToday: Date;
  startMonth: Date;
  startLastMonth: Date;
  startQuarter: Date;
}

export function getUtcRevenuePeriodBoundaries(now: Date): RevenuePeriodBoundaries {
  return {
    startToday: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    startMonth: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    startLastMonth: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
    startQuarter: new Date(
      Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1),
    ),
  };
}
