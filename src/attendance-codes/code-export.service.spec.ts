import { getQueueToken } from '@nestjs/bullmq';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { QUEUE_NAMES } from '../queues/queues.constants';
import { CodeExportService } from './code-export.service';
import {
  AttendanceCode,
  AttendanceCodeAudit,
  CodeExport,
  CodeExportFormat,
  CodeExportStatus,
  PdfLayout,
} from './entities';
import { StorageService } from '../storage/storage.service';
import { Readable } from 'node:stream';
import { StorageObjectNotFoundError } from '../storage/storage.interface';

describe('CodeExportService', () => {
  let service: CodeExportService;

  const exportRepo = {
    create: jest.fn((v: unknown) => v),
    save: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    remove: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
  };
  const codeRepo = { createQueryBuilder: jest.fn() };
  const auditRepo = { insert: jest.fn() };
  const queue = { add: jest.fn() };
  const storage = { upload: jest.fn(), getObject: jest.fn(), tryDelete: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    exportRepo.find.mockResolvedValue([]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CodeExportService,
        { provide: getRepositoryToken(CodeExport), useValue: exportRepo },
        { provide: getRepositoryToken(AttendanceCode), useValue: codeRepo },
        { provide: getRepositoryToken(AttendanceCodeAudit), useValue: auditRepo },
        { provide: getQueueToken(QUEUE_NAMES.CODE_EXPORT), useValue: queue },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    service = module.get(CodeExportService);
  });

  describe('createExport', () => {
    it('defaults PDF layout to A4 grid and enqueues the pdf job', async () => {
      exportRepo.save.mockResolvedValue({ id: 'exp-1', batch_id: null });
      await service.createExport({ format: CodeExportFormat.PDF }, 'admin-1');

      expect(exportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ layout: PdfLayout.A4_GRID }),
      );
      expect(queue.add).toHaveBeenCalledWith('export-pdf', { exportId: 'exp-1' });
    });

    it('defaults QR layout to the QR sheet and enqueues the qr job', async () => {
      exportRepo.save.mockResolvedValue({ id: 'exp-2', batch_id: null });
      await service.createExport({ format: CodeExportFormat.QR }, 'admin-1');

      expect(exportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ layout: PdfLayout.QR_SHEET }),
      );
      expect(queue.add).toHaveBeenCalledWith('export-qr', { exportId: 'exp-2' });
    });

    it('uses no layout for data formats and captures the batch scope', async () => {
      exportRepo.save.mockResolvedValue({ id: 'exp-3', batch_id: 'batch-9' });
      await service.createExport(
        { format: CodeExportFormat.CSV, filters: { batch_id: 'batch-9' } },
        'admin-1',
      );

      expect(exportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ layout: null, batch_id: 'batch-9' }),
      );
      expect(queue.add).toHaveBeenCalledWith('export-csv', { exportId: 'exp-3' });
    });
  });

  describe('getDownload', () => {
    it('refuses to serve an export that has not completed', async () => {
      exportRepo.findOne.mockResolvedValue({
        id: 'exp-1',
        status: CodeExportStatus.PROCESSING,
        file_path: null,
      });
      await expect(service.getDownload('exp-1', 'admin-1')).rejects.toThrow(
        'Export file is not available',
      );
    });
  });

  describe('getDownload from object storage', () => {
    const completed = {
      id: 'exp-9',
      batch_id: null,
      format: CodeExportFormat.CSV,
      status: CodeExportStatus.COMPLETED,
      file_path: 'code-exports/exp-9.csv',
      file_name: 'codes.csv',
    };

    it('streams the file from storage and audits the download', async () => {
      const stream = Readable.from(['a,b']);
      exportRepo.findOne.mockResolvedValue(completed);
      storage.getObject.mockResolvedValue({ stream, contentType: 'text/csv', contentLength: 3 });

      const result = await service.getDownload('exp-9', 'admin-1');

      expect(storage.getObject).toHaveBeenCalledWith('code-exports/exp-9.csv');
      expect(result).toMatchObject({ stream, fileName: 'codes.csv', contentLength: 3 });
      expect(auditRepo.insert).toHaveBeenCalled();
    });

    it('reports 404 when the stored object has disappeared', async () => {
      exportRepo.findOne.mockResolvedValue(completed);
      storage.getObject.mockRejectedValue(new StorageObjectNotFoundError('code-exports/exp-9.csv'));
      await expect(service.getDownload('exp-9', 'admin-1')).rejects.toThrow(
        'Export file is not available',
      );
    });
  });

  describe('cleanupExpired', () => {
    it('deletes the stored objects of expired exports', async () => {
      exportRepo.find.mockResolvedValue([{ id: 'e1', file_path: 'code-exports/e1.csv' }]);
      await service.cleanupExpired();
      expect(storage.tryDelete).toHaveBeenCalledWith('code-exports/e1.csv');
    });

    it('removes expired export records', async () => {
      exportRepo.find.mockResolvedValue([
        { id: 'e1', file_path: null },
        { id: 'e2', file_path: null },
      ]);
      const result = await service.cleanupExpired();
      expect(result).toEqual({ removed: 2 });
      expect(exportRepo.remove).toHaveBeenCalled();
    });
  });
});
