/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ReportsService } from './reports.service';
import { CsvExporterService } from './exporters/csv-exporter.service';
import { PdfExporterService } from './exporters/pdf-exporter.service';
import { Report, ReportType, ReportStatus, FileFormat } from './entities';
import { Payment } from '../payments/entities/payment.entity';
import { ExamAttempt } from '../exams/entities/exam-attempt.entity';
import { Lesson } from '../lessons/entities/lesson.entity';
import { NotFoundException } from '@nestjs/common';

describe('ReportsService', () => {
  let service: ReportsService;
  let reportRepository: jest.Mocked<Repository<Report>>;
  let csvExporter: jest.Mocked<CsvExporterService>;
  let pdfExporter: jest.Mocked<PdfExporterService>;

  const mockQueryBuilder = {
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
    getCount: jest.fn().mockResolvedValue(0),
    softDelete: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 0 }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportsService,
        {
          provide: getRepositoryToken(Report),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            findAndCount: jest.fn(),
            softDelete: jest.fn(),
            createQueryBuilder: jest.fn(() => mockQueryBuilder),
          },
        },
        {
          provide: getRepositoryToken(Payment),
          useValue: {
            createQueryBuilder: jest.fn(() => mockQueryBuilder),
          },
        },
        {
          provide: getRepositoryToken(ExamAttempt),
          useValue: {
            createQueryBuilder: jest.fn(() => mockQueryBuilder),
          },
        },
        {
          provide: getRepositoryToken(Lesson),
          useValue: {
            createQueryBuilder: jest.fn(() => mockQueryBuilder),
          },
        },
        {
          provide: CsvExporterService,
          useValue: {
            exportToCsv: jest.fn(),
            getFileBuffer: jest.fn(),
            deleteFile: jest.fn(),
            cleanupOldReports: jest.fn(),
          },
        },
        {
          provide: PdfExporterService,
          useValue: {
            exportToPdf: jest.fn(),
            getFileBuffer: jest.fn(),
            deleteFile: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ReportsService>(ReportsService);
    reportRepository = module.get(getRepositoryToken(Report));
    csvExporter = module.get(CsvExporterService);
    pdfExporter = module.get(PdfExporterService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createReport', () => {
    it('should create a new report with pending status', async () => {
      const mockReport: Partial<Report> = {
        id: 1,
        type: ReportType.STUDENT_PERFORMANCE,
        file_format: FileFormat.CSV,
        status: ReportStatus.PENDING,
        generated_by: 1,
        filters: { startDate: '2025-01-01', endDate: '2025-12-31' },
      };

      reportRepository.create.mockReturnValue(mockReport as Report);
      reportRepository.save.mockResolvedValue(mockReport as Report);

      const result = await service.createReport(
        ReportType.STUDENT_PERFORMANCE,
        FileFormat.CSV,
        { startDate: '2025-01-01', endDate: '2025-12-31' },
        1,
      );

      expect(reportRepository.create).toHaveBeenCalledWith({
        type: ReportType.STUDENT_PERFORMANCE,
        file_format: FileFormat.CSV,
        filters: { startDate: '2025-01-01', endDate: '2025-12-31' },
        generated_by: 1,
        status: ReportStatus.PENDING,
      });
      expect(reportRepository.save).toHaveBeenCalled();
      expect(result.status).toBe(ReportStatus.PENDING);
    });

    it('should create report with PDF format', async () => {
      const mockReport: Partial<Report> = {
        id: 2,
        type: ReportType.FINANCIAL,
        file_format: FileFormat.PDF,
        status: ReportStatus.PENDING,
        generated_by: 1,
      };

      reportRepository.create.mockReturnValue(mockReport as Report);
      reportRepository.save.mockResolvedValue(mockReport as Report);

      const result = await service.createReport(
        ReportType.FINANCIAL,
        FileFormat.PDF,
        {},
        1,
      );

      expect(result.file_format).toBe(FileFormat.PDF);
    });
  });

  describe('getReport', () => {
    it('should return a report when found', async () => {
      const mockReport: Partial<Report> = {
        id: 1,
        type: ReportType.STUDENT_PERFORMANCE,
        status: ReportStatus.COMPLETED,
      };

      reportRepository.findOne.mockResolvedValue(mockReport as Report);

      const result = await service.getReport(1);

      expect(result.id).toBe(1);
      expect(reportRepository.findOne).toHaveBeenCalledWith({
        where: { id: 1, deleted_at: expect.anything() },
        relations: ['generator'],
      });
    });

    it('should throw NotFoundException when report not found', async () => {
      reportRepository.findOne.mockResolvedValue(null);

      await expect(service.getReport(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getReports', () => {
    it('should return paginated reports', async () => {
      const mockReports: Partial<Report>[] = [
        { id: 1, type: ReportType.STUDENT_PERFORMANCE },
        { id: 2, type: ReportType.FINANCIAL },
      ];

      reportRepository.findAndCount.mockResolvedValue([
        mockReports as Report[],
        10,
      ]);

      const result = await service.getReports(1, 20);

      expect(result.data).toHaveLength(2);
      expect(result.meta.total).toBe(10);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(20);
    });

    it('should filter by userId when provided', async () => {
      reportRepository.findAndCount.mockResolvedValue([[], 0]);

      await service.getReports(1, 20, 5);

      expect(reportRepository.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            generated_by: 5,
          }),
        }),
      );
    });
  });

  describe('getReportFile', () => {
    it('should return file buffer for CSV report', async () => {
      const mockReport: Partial<Report> = {
        id: 1,
        status: ReportStatus.COMPLETED,
        file_format: FileFormat.CSV,
        file_path: '/path/to/report.csv',
      };

      reportRepository.findOne.mockResolvedValue(mockReport as Report);
      csvExporter.getFileBuffer.mockResolvedValue(Buffer.from('csv data'));

      const result = await service.getReportFile(1);

      expect(result.buffer).toBeDefined();
      expect(csvExporter.getFileBuffer).toHaveBeenCalledWith(
        '/path/to/report.csv',
      );
    });

    it('should return file buffer for PDF report', async () => {
      const mockReport: Partial<Report> = {
        id: 1,
        status: ReportStatus.COMPLETED,
        file_format: FileFormat.PDF,
        file_path: '/path/to/report.pdf',
      };

      reportRepository.findOne.mockResolvedValue(mockReport as Report);
      pdfExporter.getFileBuffer.mockResolvedValue(Buffer.from('pdf data'));

      const result = await service.getReportFile(1);

      expect(result.buffer).toBeDefined();
      expect(pdfExporter.getFileBuffer).toHaveBeenCalledWith(
        '/path/to/report.pdf',
      );
    });

    it('should throw NotFoundException when report not completed', async () => {
      const mockReport: Partial<Report> = {
        id: 1,
        status: ReportStatus.PENDING,
        file_format: FileFormat.CSV,
      };

      reportRepository.findOne.mockResolvedValue(mockReport as Report);

      await expect(service.getReportFile(1)).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteReport', () => {
    it('should delete report and associated CSV file', async () => {
      const mockReport: Partial<Report> = {
        id: 1,
        file_format: FileFormat.CSV,
        file_path: '/path/to/report.csv',
      };

      reportRepository.findOne.mockResolvedValue(mockReport as Report);
      reportRepository.softDelete.mockResolvedValue({ affected: 1 } as never);

      await service.deleteReport(1);

      expect(csvExporter.deleteFile).toHaveBeenCalledWith(
        '/path/to/report.csv',
      );
      expect(reportRepository.softDelete).toHaveBeenCalledWith(1);
    });

    it('should delete report and associated PDF file', async () => {
      const mockReport: Partial<Report> = {
        id: 1,
        file_format: FileFormat.PDF,
        file_path: '/path/to/report.pdf',
      };

      reportRepository.findOne.mockResolvedValue(mockReport as Report);
      reportRepository.softDelete.mockResolvedValue({ affected: 1 } as never);

      await service.deleteReport(1);

      expect(pdfExporter.deleteFile).toHaveBeenCalledWith(
        '/path/to/report.pdf',
      );
      expect(reportRepository.softDelete).toHaveBeenCalledWith(1);
    });

    it('should delete report without file when file_path is null', async () => {
      const mockReport: Partial<Report> = {
        id: 1,
        file_format: FileFormat.CSV,
        file_path: null,
      };

      reportRepository.findOne.mockResolvedValue(mockReport as Report);
      reportRepository.softDelete.mockResolvedValue({ affected: 1 } as never);

      await service.deleteReport(1);

      expect(csvExporter.deleteFile).not.toHaveBeenCalled();
      expect(reportRepository.softDelete).toHaveBeenCalledWith(1);
    });
  });

  describe('processReport', () => {
    it('should throw NotFoundException when report not found', async () => {
      reportRepository.findOne.mockResolvedValue(null);

      await expect(service.processReport(999)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should process student performance report', async () => {
      const mockReport: Partial<Report> = {
        id: 1,
        type: ReportType.STUDENT_PERFORMANCE,
        file_format: FileFormat.CSV,
        status: ReportStatus.PENDING,
        filters: {},
      };

      reportRepository.findOne.mockResolvedValue(mockReport as Report);
      reportRepository.save.mockImplementation((r) =>
        Promise.resolve(r as Report),
      );
      mockQueryBuilder.getRawMany.mockResolvedValue([
        {
          student_name: 'Test Student',
          score: 85,
          max_score: 100,
        },
      ]);
      csvExporter.exportToCsv.mockResolvedValue({
        filePath: '/path/to/report.csv',
        rowCount: 1,
        fileSize: 100,
      });

      await service.processReport(1);

      expect(reportRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ReportStatus.COMPLETED,
        }),
      );
    });
  });

  describe('cleanupOldReports', () => {
    it('should clean up old files and soft delete old records', async () => {
      csvExporter.cleanupOldReports.mockResolvedValue(5);
      mockQueryBuilder.execute.mockResolvedValue({ affected: 3 });

      const result = await service.cleanupOldReports();

      expect(csvExporter.cleanupOldReports).toHaveBeenCalledWith(7);
      expect(result).toBe(8); // 5 files + 3 records
    });
  });
});
