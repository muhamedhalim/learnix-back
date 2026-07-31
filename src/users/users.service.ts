import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as admin from 'firebase-admin';
import { Repository } from 'typeorm';

import { biBody } from '../i18n/error-translator.util';
import { UploadService } from '../uploads/upload.service';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { User } from './entities/user.entity';
import { UserRole } from './entities/user-role.enum';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly uploadService: UploadService,
    private readonly applicationCache: ApplicationCacheService,
  ) {}

  /**
   * Invalidate user profile cache
   */
  private async invalidateUserCache(userId: string): Promise<void> {
    await this.applicationCache.invalidate(['user_profile']);
    this.logger.debug(`Invalidated cache for user ${userId}`);
  }

  public async findAll(page = 1, limit = 10): Promise<unknown> {
    const [users, total] = await this.userRepository.findAndCount({
      select: [
        'id',
        'name',
        'email',
        'phone',
        'is_active',
        'role',
        'finance_permissions',
        'created_at',
        'profile_picture_url',
      ],
      skip: (page - 1) * limit,
      take: limit,
      order: { created_at: 'DESC' },
    });

    return {
      data: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        is_active: user.is_active,
        role: user.role,
        created_at: user.created_at,
      })),
      meta: {
        page,
        limit,
        total,
        pageCount: Math.ceil(total / limit),
      },
    };
  }

  public async findOne(id: string): Promise<unknown> {
    return await this.applicationCache.getOrCompute(
      {
        family: 'user_profile',
        endpoint: 'users.profile',
        scope: `owner:${id}`,
        parts: [id],
        ttlMs: 60_000,
      },
      async () => {

    const user = await this.userRepository.findOne({
      where: { id },
      select: [
        'id',
        'name',
        'email',
        'phone',
        'is_active',
        'role',
        'finance_permissions',
        'profile_picture_url',
        'profile_picture_thumbnail_url',
        'created_at',
        'last_login',
      ],
    });

    if (!user) {
      throw new NotFoundException(
        biBody(`User with ID ${id} not found`, `المستخدم بالمعرّف ${id} غير موجود`),
      );
    }

    const userProfile = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      is_active: user.is_active,
      role: user.role,
      // Finance permissions are administrative data. Only the admin UI needs
      // them, and non-admin profiles must never receive administrative grants.
      finance_permissions: user.role === UserRole.ADMIN ? user.finance_permissions : [],
      profile_picture_url: user.profile_picture_url,
      profile_picture_thumbnail_url: user.profile_picture_thumbnail_url,
      created_at: user.created_at,
      last_login: user.last_login,
    };

        return userProfile;
      },
    );
  }

  public async findByEmail(email: string): Promise<User | null> {
    return await this.userRepository.findOne({
      where: { email },
    });
  }

  public async findByRole(role: UserRole, page = 1, limit = 10): Promise<unknown> {
    const [users, total] = await this.userRepository.findAndCount({
      where: { role },
      select: ['id', 'name', 'email', 'phone', 'is_active', 'role', 'created_at'],
      skip: (page - 1) * limit,
      take: limit,
      order: { created_at: 'DESC' },
    });

    return {
      data: users,
      meta: {
        page,
        limit,
        total,
        pageCount: Math.ceil(total / limit),
      },
    };
  }

  public async update(id: string, updateUserDto: UpdateUserDto): Promise<unknown> {
    const user = await this.userRepository.findOne({
      where: { id },
      select: [
        'id',
        'name',
        'email',
        'phone',
        'is_active',
        'role',
        'profile_picture_url',
        'created_at',
      ],
    });

    if (!user) {
      throw new NotFoundException(
        biBody(`User with ID ${id} not found`, `المستخدم بالمعرّف ${id} غير موجود`),
      );
    }

    if (
      updateUserDto.email !== undefined &&
      updateUserDto.email !== '' &&
      updateUserDto.email !== user.email
    ) {
      const emailExists = await this.userRepository.findOne({
        where: { email: updateUserDto.email },
      });
      if (emailExists) {
        throw new ConflictException(
          biBody('Email already in use', 'البريد الإلكتروني مستخدم بالفعل'),
        );
      }
    }

    if (
      updateUserDto.phone !== undefined &&
      updateUserDto.phone !== '' &&
      updateUserDto.phone !== user.phone
    ) {
      const phoneExists = await this.userRepository.findOne({
        where: { phone: updateUserDto.phone },
      });
      if (phoneExists) {
        throw new ConflictException(
          biBody('Phone number already in use', 'رقم الهاتف مستخدم بالفعل'),
        );
      }
    }

    // Use explicit field assignment to prevent mass assignment vulnerability
    if (updateUserDto.name !== undefined) {
      user.name = updateUserDto.name;
    }
    if (updateUserDto.phone !== undefined) {
      user.phone = updateUserDto.phone;
    }
    // Guardian phones are not user columns any more — see GuardiansService.

    await this.userRepository.save(user);

    // Invalidate user profile cache
    await this.invalidateUserCache(id);

    this.logger.log(
      `User ID ${user.id} updated - Updated fields: ${Object.keys(updateUserDto).join(', ')}`,
    );

    return {
      message: 'User updated successfully',
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    };
  }

  public async remove(id: string): Promise<unknown> {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(
        biBody(`User with ID ${id} not found`, `المستخدم بالمعرّف ${id} غير موجود`),
      );
    }

    // Check if user is an admin
    if (user.role === UserRole.ADMIN) {
      // Count total active admins
      const adminCount = await this.userRepository.count({
        where: { role: UserRole.ADMIN, is_active: true },
      });

      if (adminCount <= 1) {
        throw new ForbiddenException(
          biBody(
            'Cannot delete the last admin account. Please create another admin first.',
            'لا يمكن حذف حساب المسؤول الأخير. يرجى إنشاء مسؤول آخر أولاً.',
          ),
        );
      }
    }

    user.is_active = false;
    await this.userRepository.save(user);

    // Invalidate user profile cache
    await this.invalidateUserCache(id);

    this.logger.warn(`User ID ${user.id} account deactivated - Role: ${user.role}`);

    return {
      message: 'User account deleted successfully',
    };
  }

  public async syncFirebaseUser(firebaseToken: admin.auth.DecodedIdToken): Promise<User> {
    const { uid, email, name } = firebaseToken;

    let user = await this.userRepository.findOne({
      where: { firebase_uid: uid },
    });

    if (!user) {
      const firebaseName = name as string | undefined;
      const safeName: string =
        firebaseName !== undefined && firebaseName !== '' ? firebaseName : 'Firebase User';

      user = this.userRepository.create({
        firebase_uid: uid,
        email: email ?? '',
        name: safeName,
        phone: '', // Firebase users don't have phone by default
        role: UserRole.STUDENT, // Default role for Firebase users
        is_active: true,
        password_hash: null,
      });

      user = await this.userRepository.save(user);
      this.logger.log(`New Firebase user created - ID: ${user.id}, Email: ${String(email)}`);
    }

    return user;
  }

  public async uploadProfilePicture(userId: string, file: Express.Multer.File): Promise<unknown> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(
        biBody(`User with ID ${userId} not found`, `المستخدم بالمعرّف ${userId} غير موجود`),
      );
    }

    // Delete old profile picture and thumbnail if they exist
    if (user.profile_picture_url !== null && user.profile_picture_url !== '') {
      const filename = user.profile_picture_url.split('/').pop();
      if (filename !== undefined && filename !== '') {
        try {
          await this.uploadService.deleteFile('profiles', filename);
        } catch {
          this.logger.warn(`Failed to delete old profile picture: ${filename}`);
        }
      }
    }

    if (user.profile_picture_thumbnail_url !== null && user.profile_picture_thumbnail_url !== '') {
      const thumbnailFilename = user.profile_picture_thumbnail_url.split('/').pop();
      if (thumbnailFilename !== undefined && thumbnailFilename !== '') {
        try {
          await this.uploadService.deleteFile('profiles', thumbnailFilename);
        } catch {
          this.logger.warn(`Failed to delete old thumbnail: ${thumbnailFilename}`);
        }
      }
    }

    // Upload new profile picture with thumbnail generation
    const { url, thumbnailUrl } = await this.uploadService.uploadProfilePicture(file);
    user.profile_picture_url = url;
    user.profile_picture_thumbnail_url = thumbnailUrl;

    await this.userRepository.save(user);

    // Invalidate user profile cache
    await this.invalidateUserCache(userId);

    this.logger.log(`Profile picture uploaded for user ${userId}`);

    return {
      message: 'Profile picture uploaded successfully',
      url,
      thumbnailUrl,
    };
  }

  /**
   * Delete user's profile picture
   */
  public async deleteProfilePicture(userId: string): Promise<unknown> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(
        biBody(`User with ID ${userId} not found`, `المستخدم بالمعرّف ${userId} غير موجود`),
      );
    }

    if (user.profile_picture_url === null || user.profile_picture_url === '') {
      return { message: 'No profile picture to delete' };
    }

    // Delete main profile picture
    const filename = user.profile_picture_url.split('/').pop();
    if (filename !== undefined && filename !== '') {
      try {
        await this.uploadService.deleteFile('profiles', filename);
      } catch {
        this.logger.warn(`Failed to delete profile picture: ${filename}`);
      }
    }

    // Delete thumbnail
    if (user.profile_picture_thumbnail_url !== null && user.profile_picture_thumbnail_url !== '') {
      const thumbnailFilename = user.profile_picture_thumbnail_url.split('/').pop();
      if (thumbnailFilename !== undefined && thumbnailFilename !== '') {
        try {
          await this.uploadService.deleteFile('profiles', thumbnailFilename);
        } catch {
          this.logger.warn(`Failed to delete thumbnail: ${thumbnailFilename}`);
        }
      }
    }

    // Clear URLs in database
    user.profile_picture_url = null;
    user.profile_picture_thumbnail_url = null;
    await this.userRepository.save(user);

    // Invalidate user profile cache
    await this.invalidateUserCache(userId);

    this.logger.log(`Profile picture deleted for user ${userId}`);

    return { message: 'Profile picture deleted successfully' };
  }

  /**
   * Update user role (admin only)
   */
  public async updateRole(userId: string, newRole: UserRole): Promise<unknown> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(
        biBody(`User with ID ${userId} not found`, `المستخدم بالمعرّف ${userId} غير موجود`),
      );
    }

    // Prevent removing the last admin
    if (user.role === UserRole.ADMIN && newRole !== UserRole.ADMIN) {
      const adminCount = await this.userRepository.count({
        where: { role: UserRole.ADMIN, is_active: true },
      });

      if (adminCount <= 1) {
        throw new ForbiddenException(
          biBody(
            'Cannot remove admin role from the last admin account.',
            'لا يمكن إزالة صلاحية المسؤول من حساب المسؤول الأخير.',
          ),
        );
      }
    }

    user.role = newRole;
    await this.userRepository.save(user);

    // Invalidate user profile cache
    await this.invalidateUserCache(userId);

    this.logger.log(`User ID ${userId} role changed to ${newRole}`);

    return {
      message: 'User role updated successfully',
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }
}
