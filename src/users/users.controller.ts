import {
  Body,
  Controller,
  Delete,
  FileTypeValidator,
  ForbiddenException,
  Get,
  MaxFileSizeValidator,
  Param,
  Patch,
  ParseFilePipe,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Request,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FILE_LIMITS, THROTTLE } from '../common/constants';
import { Roles } from '../common/decorators/roles.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import type { UserRequest } from '../common/interfaces/user-request.interface';
import { biBody } from '../i18n/error-translator.util';
import { UpdateUserDto } from './dto/update-user.dto';
import { AssignCallCenterRoleDto } from './dto/assign-call-center-role.dto';
import { CreateCallCenterUserDto } from './dto/create-call-center-user.dto';
import { CallCenterEmployeeFilterDto } from './dto/call-center-employee-filter.dto';
import type { DeleteSessionResponseDto, UserSessionListResponseDto } from './dto/user-session.dto';
import { SessionsService } from './sessions.service';
import { UsersService } from './users.service';

@ApiTags('Users')
@Controller('users')
@UseGuards(HybridAuthGuard)
@ApiBearerAuth('JWT-auth')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly sessionsService: SessionsService,
  ) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Get all users (admin only)' })
  public async findAll(@Query() pagination: PaginationDto): Promise<unknown> {
    return await this.usersService.findAll(pagination.page, pagination.limit);
  }

  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  public async getProfile(@Request() req: UserRequest): Promise<unknown> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException(biBody('User not authenticated', 'المستخدم غير مصادق عليه'));
    }
    return await this.usersService.findOne(userId);
  }

  @Get('call-center')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'List Call Center employees (admin only)' })
  public async findCallCenterEmployees(
    @Query() filter: CallCenterEmployeeFilterDto,
  ): Promise<unknown> {
    return await this.usersService.findCallCenterEmployees(filter);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Get user by ID (admin only)' })
  public async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return await this.usersService.findOne(id);
  }

  @Post('call-center')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Create a Call Center employee (admin only)' })
  public async createCallCenterEmployee(
    @Body() dto: CreateCallCenterUserDto,
    @Request() req: UserRequest,
  ): Promise<unknown> {
    if (req.user === undefined) {
      throw new ForbiddenException(biBody('User not authenticated', 'المستخدم غير مصادق عليه'));
    }
    return await this.usersService.createCallCenterEmployee(dto, req.user, req.ip ?? null);
  }

  @Patch(':id/call-center-role')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Assign the Call Center role to a user (admin only)' })
  public async assignCallCenterRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignCallCenterRoleDto,
    @Request() req: UserRequest,
  ): Promise<unknown> {
    if (req.user === undefined) {
      throw new ForbiddenException(biBody('User not authenticated', 'المستخدم غير مصادق عليه'));
    }
    return await this.usersService.assignCallCenterRole(id, dto, req.user, req.ip ?? null);
  }

  @Put('me')
  @ApiOperation({ summary: 'Update own profile' })
  public async updateProfile(
    @Request() req: UserRequest,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<unknown> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException(biBody('User not authenticated', 'المستخدم غير مصادق عليه'));
    }
    return await this.usersService.update(userId, updateUserDto, { requireCurrentPassword: true });
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Update user (admin only)' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<unknown> {
    return await this.usersService.update(id, updateUserDto);
  }

  @Post('me/profile-picture')
  @Throttle({ default: THROTTLE.FILE_UPLOAD })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: FILE_LIMITS.PROFILE_PICTURE_MAX_SIZE, files: 1 },
    }),
  )
  @ApiOperation({
    summary: 'Upload profile picture',
    description:
      'Uploads a profile picture with automatic thumbnail generation (150x150). ' +
      'Accepts jpg, jpeg, png, and webp files up to 5MB.',
  })
  public async uploadProfilePicture(
    @Request() req: UserRequest,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({
            maxSize: FILE_LIMITS.PROFILE_PICTURE_MAX_SIZE,
          }),
          new FileTypeValidator({ fileType: /\/(jpeg|jpg|png|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ): Promise<unknown> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException(biBody('User not authenticated', 'المستخدم غير مصادق عليه'));
    }
    return await this.usersService.uploadProfilePicture(userId, file);
  }

  @Delete('me/profile-picture')
  @ApiOperation({
    summary: 'Delete profile picture',
    description: 'Deletes the current user profile picture and thumbnail.',
  })
  public async deleteProfilePicture(@Request() req: UserRequest): Promise<unknown> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException(biBody('User not authenticated', 'المستخدم غير مصادق عليه'));
    }
    return await this.usersService.deleteProfilePicture(userId);
  }

  @Get('me/sessions')
  @ApiOperation({
    summary: 'List active sessions',
    description: 'Returns all active sessions for the current user across all devices.',
  })
  @ApiResponse({
    status: 200,
    description: 'Array of active sessions',
  })
  public async getUserSessions(@Request() req: UserRequest): Promise<UserSessionListResponseDto> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException(biBody('User not authenticated', 'المستخدم غير مصادق عليه'));
    }
    const sessions = await this.sessionsService.getUserSessions(
      userId,
      req.user?.sessionId ?? null,
    );
    return { data: sessions };
  }

  @Delete('me/sessions/:sessionId')
  @ApiOperation({
    summary: 'Delete a specific session',
    description:
      'Ends a specific session, logging out that device. Cannot delete the current session.',
  })
  @ApiResponse({
    status: 200,
    description: 'Session deleted successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Cannot delete current session or session belonging to another user',
  })
  @ApiResponse({
    status: 404,
    description: 'Session not found',
  })
  public async deleteSession(
    @Request() req: UserRequest,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
  ): Promise<DeleteSessionResponseDto> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException(biBody('User not authenticated', 'المستخدم غير مصادق عليه'));
    }
    await this.sessionsService.deleteSession(userId, sessionId, req.user?.sessionId ?? null);
    return { message: 'Session deleted successfully' };
  }

  @Delete('me')
  @ApiOperation({ summary: 'Delete own account' })
  public async deleteOwnAccount(@Request() req: UserRequest): Promise<unknown> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException(biBody('User not authenticated', 'المستخدم غير مصادق عليه'));
    }
    return await this.usersService.remove(userId);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Delete user (admin only)' })
  public async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Request() req: UserRequest,
  ): Promise<unknown> {
    const userId = req.user?.userId;
    if (userId === undefined || userId === '') {
      throw new ForbiddenException(biBody('User not authenticated', 'المستخدم غير مصادق عليه'));
    }
    if (id === userId) {
      throw new ForbiddenException(
        biBody(
          'Cannot delete your own account through admin endpoint. Use DELETE /users/me instead.',
          'لا يمكنك حذف حسابك الخاص عبر واجهة الإدارة. يرجى استخدام DELETE /users/me بدلاً من ذلك.',
        ),
      );
    }
    return await this.usersService.remove(id);
  }
}
