import { EnforceAttendanceStatuses2064000000000 } from './2064000000000-EnforceAttendanceStatuses';

describe('EnforceAttendanceStatuses2064000000000', () => {
  it('adds a reversible database constraint for the four supported statuses', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const migration = new EnforceAttendanceStatuses2064000000000();

    await migration.up({ query } as never);
    await migration.down({ query } as never);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('CHK_attendance_records_status'));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("'excused'"));
  });
});
