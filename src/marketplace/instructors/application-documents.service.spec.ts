import type { MarketplaceStorageService } from '../common/marketplace-storage.service';
import { InstructorApplication } from './entities/instructor-application.entity';
import { ApplicationDocumentsService } from './application-documents.service';

function buildApplication(overrides: Partial<InstructorApplication> = {}): InstructorApplication {
  return {
    id: 'app-1',
    user_id: 'user-1',
    status: 'draft',
    document_keys: [],
    ...overrides,
  } as unknown as InstructorApplication;
}

function buildService(row: InstructorApplication | null): {
  service: ApplicationDocumentsService;
  storage: jest.Mocked<MarketplaceStorageService>;
  applications: { findOne: jest.Mock; count: jest.Mock; save: jest.Mock };
} {
  const applications = {
    // Honours the `where` list the service passes: only a draft/rejected row is "editable".
    findOne: jest.fn(async (options?: { where?: unknown }) => {
      if (!row) return null;
      const where = options?.where;
      if (Array.isArray(where)) {
        return where.some((condition: { status?: string }) => condition.status === row.status) ? row : null;
      }
      return row;
    }),
    count: jest.fn(async () => (row ? 1 : 0)),
    save: jest.fn(async (entity: InstructorApplication) => entity),
  };
  const storage = {
    uploadPrivate: jest.fn().mockResolvedValue({ url: '', path: 'k', size: 100, visibility: 'private' }),
    getSignedUrl: jest.fn(async (path: string, authorize: () => Promise<boolean> | boolean) => {
      const ok = await authorize();
      if (!ok) throw new Error('forbidden');
      return `https://signed/${path}`;
    }),
  } as unknown as jest.Mocked<MarketplaceStorageService>;

  return { service: new ApplicationDocumentsService(applications as never, storage), storage, applications };
}

const validInput = { buffer: Buffer.from('x'), contentType: 'application/pdf', size: 1000 };

describe('ApplicationDocumentsService', () => {
  describe('upload', () => {
    it('uploads a document and appends its key to the application (never a URL, FR-303)', async () => {
      const { service, applications } = buildService(buildApplication());
      const result = await service.upload('user-1', validInput);
      expect(result.key).toMatch(/^marketplace\/applications\/app-1\/documents\//);
      expect(applications.save).toHaveBeenCalledWith(
        expect.objectContaining({ document_keys: [result.key] }),
      );
    });

    it('refuses when no application exists', async () => {
      const { service } = buildService(null);
      await expect(service.upload('user-1', validInput)).rejects.toThrow();
    });

    it('refuses when the application is not draft or rejected', async () => {
      const { service } = buildService(buildApplication({ status: 'submitted' } as never));
      await expect(service.upload('user-1', validInput)).rejects.toThrow();
    });

    it('answers 404 when the user has no application and 403 when none is editable', async () => {
      await expect(buildService(null).service.upload('user-1', validInput)).rejects.toMatchObject({ status: 404 });
      const { service } = buildService(buildApplication({ status: 'submitted' } as never));
      await expect(service.upload('user-1', validInput)).rejects.toMatchObject({ status: 403 });
    });

    it('looks for the newest draft or rejected application, not just any row of the user', async () => {
      const { service, applications } = buildService(buildApplication({ status: 'rejected' } as never));
      await service.upload('user-1', validInput);
      expect(applications.findOne).toHaveBeenCalledWith({
        where: [
          { user_id: 'user-1', status: 'draft' },
          { user_id: 'user-1', status: 'rejected' },
        ],
        order: { created_at: 'DESC' },
      });
    });

    it('refuses an unsupported file type — no identity-document kind exists to mislabel into (FR-010)', async () => {
      const { service } = buildService(buildApplication());
      await expect(
        service.upload('user-1', { ...validInput, contentType: 'application/x-executable' }),
      ).rejects.toThrow();
    });

    it('refuses a file over the size limit, naming the limit', async () => {
      const { service } = buildService(buildApplication());
      await expect(
        service.upload('user-1', { ...validInput, size: 20 * 1024 * 1024 }),
      ).rejects.toThrow(/10MB/);
    });

    it('refuses an 11th document on the same application', async () => {
      const existingKeys = Array.from({ length: 10 }, (_, i) => `k${i}`);
      const { service } = buildService(buildApplication({ document_keys: existingKeys }));
      await expect(service.upload('user-1', validInput)).rejects.toThrow();
    });

    it('accepts a valid image document', async () => {
      const { service } = buildService(buildApplication());
      await expect(service.upload('user-1', { ...validInput, contentType: 'image/png' })).resolves.toBeDefined();
    });
  });

  describe('getSignedDocumentUrl', () => {
    it('authorizes the applicant themselves', async () => {
      const { service } = buildService(buildApplication({ document_keys: ['k1'] } as never));
      await expect(service.getSignedDocumentUrl('app-1', 'k1', 'user-1', false)).resolves.toContain('https://signed');
    });

    it('authorizes a reviewing administrator', async () => {
      const { service } = buildService(buildApplication({ document_keys: ['k1'] } as never));
      await expect(service.getSignedDocumentUrl('app-1', 'k1', 'some-admin', true)).resolves.toContain('https://signed');
    });

    it('refuses a third party who is neither the applicant nor an admin', async () => {
      const { service } = buildService(buildApplication({ document_keys: ['k1'] } as never));
      await expect(service.getSignedDocumentUrl('app-1', 'k1', 'stranger', false)).rejects.toThrow();
    });

    it('refuses a key that is not actually attached to the application, even for the applicant', async () => {
      const { service } = buildService(buildApplication({ document_keys: ['k1'] } as never));
      await expect(service.getSignedDocumentUrl('app-1', 'not-a-real-key', 'user-1', false)).rejects.toThrow();
    });
  });
});
