import { HttpStatus } from '@nestjs/common';

import type { Response } from 'express';

import type { AttendanceRecord } from '../entities/attendance-record.entity';
import { AdminAttendanceController, ATTENDANCE_EXPORT_LIMITS } from './admin-attendance.controller';

describe('AdminAttendanceController — export', () => {
  let controller: AdminAttendanceController;
  let attendanceService: {
    getAllAttendance: jest.Mock;
    countAttendanceForExport: jest.Mock;
    iterateAttendanceForExport: jest.Mock;
  };
  let exportService: { describe: jest.Mock; write: jest.Mock };
  let response: Response & { status: jest.Mock; json: jest.Mock; setHeader: jest.Mock; destroy: jest.Mock };

  beforeEach(() => {
    attendanceService = {
      getAllAttendance: jest.fn(),
      countAttendanceForExport: jest.fn().mockResolvedValue(0),
      iterateAttendanceForExport: jest.fn(() => (async function* () {})()),
    };
    exportService = {
      describe: jest.fn(() => ({ contentType: 'text/csv; charset=utf-8', filename: 'a.csv' })),
      write: jest.fn().mockResolvedValue(0),
    };
    const json = jest.fn();
    response = {
      status: jest.fn(() => ({ json })),
      json,
      setHeader: jest.fn(),
      destroy: jest.fn(),
    } as never;
    controller = new AdminAttendanceController(
      attendanceService as never,
      exportService as never,
    );
  });

  it('streams the complete filtered dataset — never a page of it', async () => {
    attendanceService.countAttendanceForExport.mockResolvedValue(4321);
    exportService.write.mockResolvedValue(4321);

    await controller.exportAttendance('csv', { status: 'present', page: 1, limit: 20 } as never, response);

    // The export never asks the paginated listing for its data.
    expect(attendanceService.getAllAttendance).not.toHaveBeenCalled();
    // The filters reach the iterator verbatim; page/limit are irrelevant to it.
    expect(attendanceService.iterateAttendanceForExport).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'present' }),
    );
    expect(exportService.write).toHaveBeenCalledWith(
      expect.anything(),
      'csv',
      response,
      expect.objectContaining({ total: 4321, filters: { status: 'present' } }),
    );
    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
  });

  it.each(['csv', 'xlsx', 'pdf'] as const)(
    'refuses a %s export above its documented ceiling instead of truncating it',
    async (format) => {
      const limit = ATTENDANCE_EXPORT_LIMITS[format];
      attendanceService.countAttendanceForExport.mockResolvedValue(limit + 1);

      await controller.exportAttendance(format, {} as never, response);

      expect(response.status).toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(response.json).toHaveBeenCalledWith(
        expect.objectContaining({ total: limit + 1, maximum: limit, format }),
      );
      // Nothing was written: no partial file masquerading as a complete one.
      expect(exportService.write).not.toHaveBeenCalled();
    },
  );

  it.each(['csv', 'xlsx', 'pdf'] as const)(
    'exports a %s dataset exactly at the ceiling',
    async (format) => {
      const limit = ATTENDANCE_EXPORT_LIMITS[format];
      attendanceService.countAttendanceForExport.mockResolvedValue(limit);
      exportService.write.mockResolvedValue(limit);

      await controller.exportAttendance(format, {} as never, response);

      expect(exportService.write).toHaveBeenCalled();
      expect(response.status).not.toHaveBeenCalledWith(HttpStatus.UNPROCESSABLE_ENTITY);
    },
  );

  it('aborts the transfer rather than finishing a half-written file', async () => {
    attendanceService.countAttendanceForExport.mockResolvedValue(10);
    const failure = new Error('database went away mid-export');
    exportService.write.mockRejectedValue(failure);

    await controller.exportAttendance('xlsx', {} as never, response);

    expect(response.destroy).toHaveBeenCalledWith(failure);
  });

  it('rejects an unsupported format before touching the database', async () => {
    await controller.exportAttendance('json' as never, {} as never, response);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(attendanceService.countAttendanceForExport).not.toHaveBeenCalled();
  });

  it('leaves the paginated listing endpoint untouched', async () => {
    const page = { data: [] as AttendanceRecord[], meta: { total: 0 } };
    attendanceService.getAllAttendance.mockResolvedValue(page);

    await expect(controller.getAllAttendance({ page: 2, limit: 50 } as never)).resolves.toBe(page);
    expect(attendanceService.getAllAttendance).toHaveBeenCalledWith({ page: 2, limit: 50 });
  });
});
