import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { FileListQueryDto } from './dto/file-list-query.dto';
import { UploadedFile } from './entities/uploaded-file.entity';
import { FileManagementService } from './file-management.service';
import { UploadService } from './upload.service';

describe('FileManagementService', () => {
  const countQuery = {
    getCount: jest.fn(),
  };
  const listQuery = {
    where: jest.fn(),
    andWhere: jest.fn(),
    clone: jest.fn(),
    select: jest.fn(),
    addSelect: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    offset: jest.fn(),
    limit: jest.fn(),
    setParameters: jest.fn(),
    getQuery: jest.fn(),
    getParameters: jest.fn(),
    getRawMany: jest.fn(),
    getRawOne: jest.fn(),
  };
  const uploadedFilesRepository = {
    createQueryBuilder: jest.fn(),
  };
  const uploadService = {
    deleteFile: jest.fn(),
  };

  let service: FileManagementService;

  beforeEach(async () => {
    jest.clearAllMocks();
    for (const method of [
      'where',
      'andWhere',
      'select',
      'addSelect',
      'orderBy',
      'addOrderBy',
      'offset',
      'limit',
      'setParameters',
    ] as const) {
      listQuery[method].mockReturnValue(listQuery);
    }
    listQuery.clone.mockReturnValueOnce(countQuery).mockReturnValueOnce(listQuery);
    listQuery.getQuery.mockReturnValue('SELECT uploaded_file.id FROM uploaded_files');
    listQuery.getParameters.mockReturnValue({ userId: 'user-1' });
    uploadedFilesRepository.createQueryBuilder.mockReturnValue(listQuery);

    const module = await Test.createTestingModule({
      providers: [
        FileManagementService,
        {
          provide: getRepositoryToken(UploadedFile),
          useValue: uploadedFilesRepository,
        },
        { provide: UploadService, useValue: uploadService },
      ],
    }).compile();

    service = module.get(FileManagementService);
  });

  describe('getUserFiles', () => {
    it('uses one count query and one paginated list query for any result size', async () => {
      countQuery.getCount.mockResolvedValue(1_000);
      listQuery.getRawMany.mockResolvedValue(
        Array.from({ length: 100 }, (_, index) => ({
          id: `file-${String(index)}`,
          filename: `stored-${String(index)}.pdf`,
          original_filename: `original-${String(index)}.pdf`,
          folder: 'resources',
          mime_type: 'application/pdf',
          size: '2048',
          created_at: '2026-07-14T10:00:00.000Z',
          used_in: [],
        })),
      );

      const result = await service.getUserFiles('user-1', {
        page: 3,
        limit: 100,
      });

      expect(countQuery.getCount).toHaveBeenCalledTimes(1);
      expect(listQuery.getRawMany).toHaveBeenCalledTimes(1);
      expect(uploadedFilesRepository.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(listQuery.offset).toHaveBeenCalledWith(200);
      expect(listQuery.limit).toHaveBeenCalledWith(100);
      expect(result.data).toHaveLength(100);
      expect(result.meta).toEqual({
        page: 3,
        limit: 100,
        total: 1_000,
        totalPages: 10,
      });
    });

    it('filters before cloning and aggregates usage with current schema columns', async () => {
      countQuery.getCount.mockResolvedValue(1);
      listQuery.getRawMany.mockResolvedValue([
        {
          id: 'file-1',
          filename: 'stored.pdf',
          original_filename: 'Algebra.pdf',
          folder: 'resources',
          mime_type: 'application/pdf',
          size: 512,
          created_at: new Date('2026-07-14T10:00:00.000Z'),
          used_in: JSON.stringify([
            {
              entityType: 'book',
              entityId: 'book-1',
              field: 'book_file',
              entityTitle: 'Algebra',
            },
          ]),
        },
      ]);

      const result = await service.getUserFiles('user-1', {
        page: 1,
        limit: 10,
        folder: 'resources',
        search: 'Algebra',
      });

      expect(listQuery.andWhere).toHaveBeenCalledWith('uploaded_file.folder = :folder', {
        folder: 'resources',
      });
      expect(listQuery.andWhere).toHaveBeenCalledWith(
        '(uploaded_file.filename ILIKE :search OR uploaded_file.original_filename ILIKE :search)',
        { search: '%Algebra%' },
      );
      const usageSelect = listQuery.addSelect.mock.calls.find(
        ([, alias]) => alias === 'used_in',
      )?.[0] as string;
      expect(usageSelect).toContain('lesson.thumbnail');
      expect(usageSelect).toContain('book.book_file');
      expect(usageSelect).not.toContain('lesson.thumbnail_url');
      expect(usageSelect).not.toContain('book.pdf_url');
      expect(result.data[0]?.usedIn).toEqual([
        {
          entityType: 'book',
          entityId: 'book-1',
          field: 'book_file',
          entityTitle: 'Algebra',
        },
      ]);
    });
  });

  describe('getFileUsage', () => {
    it('uses one database aggregation query instead of five repository queries', async () => {
      listQuery.getRawOne.mockResolvedValue({
        filename: 'stored.pdf',
        used_in: [{ entityType: 'book', entityId: 'book-1', field: 'book_file' }],
      });

      const result = await service.getFileUsage('stored.pdf');

      expect(uploadedFilesRepository.createQueryBuilder).toHaveBeenCalledTimes(1);
      expect(listQuery.getRawOne).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        filename: 'stored.pdf',
        isInUse: true,
        usedIn: [{ entityType: 'book', entityId: 'book-1', field: 'book_file' }],
      });
    });
  });
});

describe('FileListQueryDto', () => {
  it('transforms valid second-page parameters and trims search', async () => {
    const query = plainToInstance(FileListQueryDto, {
      page: '2',
      limit: '25',
      folder: 'resources',
      search: '  algebra  ',
    });

    await expect(validate(query)).resolves.toHaveLength(0);
    expect(query).toMatchObject({
      page: 2,
      limit: 25,
      folder: 'resources',
      search: 'algebra',
    });
  });

  it('rejects an unbounded page size', async () => {
    const query = plainToInstance(FileListQueryDto, { page: '1', limit: '101' });

    const errors = await validate(query);
    expect(errors.some((error) => error.property === 'limit')).toBe(true);
  });
});
