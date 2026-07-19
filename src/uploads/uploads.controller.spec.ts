import { NotFoundException } from '@nestjs/common';

import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { UserRole } from '../users/entities/user-role.enum';
import type { FileManagementService } from './file-management.service';
import { UploadsController } from './uploads.controller';

/**
 * Object-level authorization coverage for the file-usage endpoint (SEC-17 /
 * IDOR). Only the uploader or an admin may read a file's metadata + usage;
 * everyone else must receive 404 so a leaked file UUID cannot enumerate
 * another user's uploads or the entities they belong to.
 */
describe('UploadsController — getFileUsage authorization (IDOR)', () => {
  const OWNER_ID = 'owner-1';
  const FILE = {
    id: 'file-1',
    filename: 'secret.pdf',
    original_filename: 'secret.pdf',
    folder: 'resources',
    mime_type: 'application/pdf',
    size: 1024,
    created_at: new Date(),
    uploader_id: OWNER_ID,
  };

  function buildController(fileByIdResult: unknown): UploadsController {
    const configService = { get: () => '/app/uploads' } as unknown as ConstructorParameters<
      typeof UploadsController
    >[0];
    const fileService = {
      getFileById: jest.fn().mockResolvedValue(fileByIdResult),
      getFileUsage: jest.fn().mockResolvedValue({ filename: FILE.filename, isInUse: false, usedIn: [] }),
    } as unknown as FileManagementService;
    return new UploadsController(configService, fileService);
  }

  const asUser = (userId: string, role: UserRole): JwtPayload => ({
    userId,
    email: `${userId}@example.com`,
    name: userId,
    role,
  });

  it('returns usage to the uploader', async () => {
    const controller = buildController(FILE);
    const result = await controller.getFileUsage(asUser(OWNER_ID, UserRole.STUDENT), FILE.id);
    expect(result.data.id).toBe(FILE.id);
  });

  it('returns usage to an admin (even when not the uploader)', async () => {
    const controller = buildController(FILE);
    const result = await controller.getFileUsage(asUser('admin-9', UserRole.ADMIN), FILE.id);
    expect(result.data.id).toBe(FILE.id);
  });

  it('rejects a different (non-owner, non-admin) user with 404, not the metadata', async () => {
    const controller = buildController(FILE);
    await expect(
      controller.getFileUsage(asUser('attacker-2', UserRole.TEACHER), FILE.id),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns 404 for a missing file', async () => {
    const controller = buildController(null);
    await expect(
      controller.getFileUsage(asUser(OWNER_ID, UserRole.STUDENT), 'missing'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
