import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';

import * as bcrypt from 'bcryptjs';
import * as admin from 'firebase-admin';
import { Repository } from 'typeorm';

import { biBody } from '../i18n/error-translator.util';
import { UploadService } from '../uploads/upload.service';
import { ApplicationCacheService } from '../common/cache/application-cache.service';
import type { JwtPayload } from '../common/interfaces/user-request.interface';
import { ActivityLogsService } from '../activity-logs/activity-logs.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { CreateCallCenterUserDto } from './dto/create-call-center-user.dto';
import { AssignCallCenterRoleDto } from './dto/assign-call-center-role.dto';
import { CallCenterEmployeeFilterDto } from './dto/call-center-employee-filter.dto';
import { User } from './entities/user.entity';
import { UserRole } from './entities/user-role.enum';
import { UserStatus } from './entities/user-status.enum';
import {
  CallCenterEmployeeCreatedEvent,
  CallCenterRoleAssignedEvent,
} from '../activity-logs/events/audit.events';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly uploadService: UploadService,
    private readonly applicationCache: ApplicationCacheService,
    private readonly configService: ConfigService,
    private readonly activityLogsService: ActivityLogsService,
  ) {}

  /**
   * Invalidate user profile cache
   */
  private async invalidateUserCache(userId: string): Promise<void> {
    await this.applicationCache.invalidate(['user_profile']);
    this.logger.debug(`Invalidated cache for user ${userId}`);
  }

  /**
   * The platform's Call Center access model is role-based. There is no
   * per-employee permission assignment for this role; finance permissions are
   * a separate Admin-only capability and must never be copied to staff.
   */
  private toCallCenterEmployeeSummary(user: User): Record<string, unknown> {
    return {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      phone: user.phone,
      is_active: user.is_active,
      status: user.status,
      role: user.role,
      created_at: user.created_at,
      access: {
        model: 'role',
        role: UserRole.CALL_CENTER,
        individual_permissions: [],
      },
    };
  }

  public async findAll(page = 1, limit = 10): Promise<unknown> {
    const [users, total] = await this.userRepository.findAndCount({
      select: [
        'id',
        'name',
        'email',
        'phone',
        'is_active',
        'status',
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
        status: user.status,
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

  /** Admin-only Call Center workforce projection; never returns credentials or tokens. */
  public async findCallCenterEmployees(filter: CallCenterEmployeeFilterDto): Promise<unknown> {
    const search = filter.search?.trim();
    const query = this.userRepository
      .createQueryBuilder('user')
      .select([
        'user.id',
        'user.username',
        'user.name',
        'user.email',
        'user.phone',
        'user.is_active',
        'user.status',
        'user.role',
        'user.created_at',
      ])
      .where('user.role = :role', { role: UserRole.CALL_CENTER });

    if (search !== undefined && search !== '') {
      query.andWhere(
        `(user.name ILIKE :search OR user.username ILIKE :search OR user.email ILIKE :search OR user.phone ILIKE :search)`,
        { search: `%${search}%` },
      );
    }

    const [users, total] = await query
      .orderBy('user.created_at', 'DESC')
      .skip((filter.page - 1) * filter.limit)
      .take(filter.limit)
      .getManyAndCount();

    return {
      data: users.map((user) => this.toCallCenterEmployeeSummary(user)),
      meta: {
        page: filter.page,
        limit: filter.limit,
        total,
        pageCount: Math.ceil(total / filter.limit),
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

    const email = updateUserDto.email?.trim().toLowerCase();
    if (email !== undefined && email !== '' && email !== user.email) {
      const emailExists = await this.userRepository.findOne({
        where: { email },
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
    if (email !== undefined && email !== '') {
      user.email = email;
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
        status: UserStatus.PENDING,
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

  private assertAdminActor(actor: JwtPayload): void {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        biBody(
          'Only an administrator can manage Call Center employees',
          'يمكن للمسؤول فقط إدارة موظفي مركز الاتصال',
        ),
      );
    }
  }

  /**
   * Creates a Call Center employee through the only server-side provisioning
   * path. The role is never supplied by the caller and is fixed here.
   */
  public async createCallCenterEmployee(
    dto: CreateCallCenterUserDto,
    actor: JwtPayload,
    ipAddress: string | null,
  ): Promise<unknown> {
    this.assertAdminActor(actor);

    const username = dto.username.trim();
    const email = dto.email.trim().toLowerCase();
    const phone = dto.phone.trim();
    const existing = await this.userRepository.findOne({
      where: [{ username }, { email }, { phone }],
    });
    if (existing) {
      throw new ConflictException(
        biBody(
          'Username, email, or phone is already in use',
          'اسم المستخدم أو البريد الإلكتروني أو رقم الهاتف مستخدم بالفعل',
        ),
      );
    }

    const passwordHash = await bcrypt.hash(
      dto.password,
      this.configService.get<number>('BCRYPT_ROUNDS') ?? 12,
    );
    const user = this.userRepository.create({
      username,
      name: dto.name.trim(),
      email,
      phone,
      password_hash: passwordHash,
      role: UserRole.CALL_CENTER,
      status: UserStatus.APPROVED,
      is_active: true,
    });
    const created = await this.userRepository.save(user);

    await this.invalidateUserCache(created.id);
    await this.activityLogsService.recordAuditEvent(
      new CallCenterEmployeeCreatedEvent(
        actor.userId,
        created.id,
        { userName: created.name, userRole: UserRole.CALL_CENTER },
        ipAddress ?? undefined,
      ),
    );

    return {
      message: 'Call Center employee created successfully',
      user: this.toCallCenterEmployeeSummary(created),
    };
  }

  /**
   * Changes an existing account into a Call Center employee. It deliberately
   * does not expose a generic role setter, so no caller can select arbitrary
   * roles or bypass the Admin-only controller guard.
   */
  public async assignCallCenterRole(
    userId: string,
    dto: AssignCallCenterRoleDto,
    actor: JwtPayload,
    ipAddress: string | null,
  ): Promise<unknown> {
    this.assertAdminActor(actor);
    const user = await this.userRepository.findOne({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(
        biBody(`User with ID ${userId} not found`, `المستخدم بالمعرّف ${userId} غير موجود`),
      );
    }

    if (user.role !== UserRole.STUDENT && user.role !== UserRole.TEACHER) {
      throw new BadRequestException(
        biBody(
          'Only student or teacher accounts can be assigned the Call Center role',
          'يمكن تعيين دور مركز الاتصال لحسابات الطلاب أو المعلمين فقط',
        ),
      );
    }

    const previousRole = user.role;
    const previousStatus = user.status;
    const wasActive = user.is_active;
    user.role = UserRole.CALL_CENTER;
    // A role assignment is a provisioning action. The authentication guard
    // requires both values, so leaving the former student/teacher lifecycle
    // status intact would create a staff account that cannot sign in.
    user.status = UserStatus.APPROVED;
    user.is_active = true;
    await this.userRepository.save(user);

    // Invalidate user profile cache
    await this.invalidateUserCache(userId);

    const reason = dto.reason?.trim();
    await this.activityLogsService.recordAuditEvent(
      new CallCenterRoleAssignedEvent(
        actor.userId,
        user.id,
        {
          userName: user.name,
          previousRole,
          previousStatus,
          wasActive,
          ...(reason !== undefined && reason !== '' ? { reason } : {}),
        },
        ipAddress ?? undefined,
      ),
    );

    this.logger.log(`User ID ${userId} role changed to ${UserRole.CALL_CENTER}`);

    return {
      message: 'User role updated successfully',
      user: this.toCallCenterEmployeeSummary(user),
    };
  }
}
