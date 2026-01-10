import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
  Inject,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { User } from './entities/user.entity';
import { UserRole } from './entities/user-role.enum';
import { UpdateUserDto } from './dto/update-user.dto';
import { UploadService } from '../uploads/upload.service';
import * as admin from 'firebase-admin';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private uploadService: UploadService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  /**
   * Get cache key for a specific user profile
   */
  private getUserCacheKey(userId: number): string {
    return `user:profile:${userId}`;
  }

  /**
   * Invalidate user profile cache
   */
  private async invalidateUserCache(userId: number) {
    const cacheKey = this.getUserCacheKey(userId);
    await this.cacheManager.del(cacheKey);
    this.logger.debug(`Invalidated cache for user ${userId}`);
  }

  async findAll(page: number = 1, limit: number = 10) {
    const [users, total] = await this.userRepository.findAndCount({
      select: [
        'id',
        'name',
        'email',
        'phone',
        'parent_phone',
        'is_active',
        'role',
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

  async findOne(id: number) {
    // Try to get from cache first
    const cacheKey = this.getUserCacheKey(id);
    const cached = await this.cacheManager.get(cacheKey);
    if (cached) {
      this.logger.debug(`Cache HIT for user ${id}`);
      return cached;
    }

    this.logger.debug(`Cache MISS for user ${id}`);

    const user = await this.userRepository.findOne({
      where: { id },
      select: [
        'id',
        'name',
        'email',
        'phone',
        'parent_phone',
        'is_active',
        'role',
        'profile_picture_url',
        'created_at',
        'last_login',
      ],
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    const userProfile = {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      parent_phone: user.parent_phone,
      is_active: user.is_active,
      role: user.role,
      profile_picture_url: user.profile_picture_url,
      created_at: user.created_at,
      last_login: user.last_login,
    };

    // Cache for 10 minutes (600000 milliseconds)
    await this.cacheManager.set(cacheKey, userProfile, 600000);
    this.logger.debug(`Cached user ${id} for 10 minutes`);

    return userProfile;
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({
      where: { email },
    });
  }

  async findByRole(role: UserRole, page: number = 1, limit: number = 10) {
    const [users, total] = await this.userRepository.findAndCount({
      where: { role },
      select: [
        'id',
        'name',
        'email',
        'phone',
        'parent_phone',
        'is_active',
        'role',
        'created_at',
      ],
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

  async update(id: number, updateUserDto: UpdateUserDto) {
    const user = await this.userRepository.findOne({
      where: { id },
      select: [
        'id',
        'name',
        'email',
        'phone',
        'parent_phone',
        'is_active',
        'role',
        'profile_picture_url',
        'created_at',
      ],
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    if (updateUserDto.email && updateUserDto.email !== user.email) {
      const emailExists = await this.userRepository.findOne({
        where: { email: updateUserDto.email },
      });
      if (emailExists) {
        throw new ConflictException('Email already in use');
      }
    }

    if (updateUserDto.phone && updateUserDto.phone !== user.phone) {
      const phoneExists = await this.userRepository.findOne({
        where: { phone: updateUserDto.phone },
      });
      if (phoneExists) {
        throw new ConflictException('Phone number already in use');
      }
    }

    // Use explicit field assignment to prevent mass assignment vulnerability
    if (updateUserDto.name !== undefined) {
      user.name = updateUserDto.name;
    }
    if (updateUserDto.phone !== undefined) {
      user.phone = updateUserDto.phone;
    }
    if (updateUserDto.parentPhone !== undefined) {
      user.parent_phone = updateUserDto.parentPhone;
    }

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

  async remove(id: number) {
    const user = await this.userRepository.findOne({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${id} not found`);
    }

    // Check if user is an admin
    if (user.role === UserRole.ADMIN) {
      // Count total active admins
      const adminCount = await this.userRepository.count({
        where: { role: UserRole.ADMIN, is_active: true },
      });

      if (adminCount <= 1) {
        throw new ForbiddenException(
          'Cannot delete the last admin account. Please create another admin first.',
        );
      }
    }

    user.is_active = false;
    await this.userRepository.save(user);

    // Invalidate user profile cache
    await this.invalidateUserCache(id);

    this.logger.warn(
      `User ID ${user.id} account deactivated - Role: ${user.role}`,
    );

    return {
      message: 'User account deleted successfully',
    };
  }

  async syncFirebaseUser(
    firebaseToken: admin.auth.DecodedIdToken,
  ): Promise<User> {
    const { uid, email, name } = firebaseToken;

    let user = await this.userRepository.findOne({
      where: { firebase_uid: uid },
    });

    if (!user) {
      const safeName: string = (name as string) || 'Firebase User';

      user = this.userRepository.create({
        firebase_uid: uid,
        email: email || '',
        name: safeName,
        phone: '', // Firebase users don't have phone by default
        role: UserRole.STUDENT, // Default role for Firebase users
        is_active: true,
        password_hash: null,
      });

      user = await this.userRepository.save(user);
      this.logger.log(
        `New Firebase user created - ID: ${user.id}, Email: ${email}`,
      );
    }

    return user;
  }

  async uploadProfilePicture(userId: number, file: Express.Multer.File) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    if (user.profile_picture_url) {
      const filename = user.profile_picture_url.split('/').pop();
      if (filename) {
        await this.uploadService.deleteFile('profiles', filename);
      }
    }

    const { url } = await this.uploadService.uploadFile(file, 'profiles');
    user.profile_picture_url = url;

    await this.userRepository.save(user);

    // Invalidate user profile cache
    await this.invalidateUserCache(userId);

    return {
      message: 'Profile picture uploaded successfully',
      url,
    };
  }

  /**
   * Update user role (admin only)
   */
  async updateRole(userId: number, newRole: UserRole) {
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    // Prevent removing the last admin
    if (user.role === UserRole.ADMIN && newRole !== UserRole.ADMIN) {
      const adminCount = await this.userRepository.count({
        where: { role: UserRole.ADMIN, is_active: true },
      });

      if (adminCount <= 1) {
        throw new ForbiddenException(
          'Cannot remove admin role from the last admin account.',
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
