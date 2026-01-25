import {
  Body,
  Controller,
  Delete,
  FileTypeValidator,
  ForbiddenException,
  Get,
  MaxFileSizeValidator,
  Param,
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
import { ApiBearerAuth,ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { HybridAuthGuard } from '../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FILE_LIMITS,THROTTLE } from '../common/constants';
import { Roles } from '../common/decorators/roles.decorator';
import { PaginationDto } from '../common/dto/pagination.dto';
import type { UserRequest } from '../common/interfaces/user-request.interface';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@Controller('users')
@UseGuards(HybridAuthGuard)
@ApiBearerAuth('JWT-auth')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Get all users (admin only)' })
  public async findAll(@Query() pagination: PaginationDto): Promise<unknown> {
    return this.usersService.findAll(pagination.page, pagination.limit);
  }

  @ApiOperation({ summary: 'Get current user profile' })
  public async getProfile(@Request() req: UserRequest): Promise<unknown> {
    const userId = req.user?.userId;
    if (!userId) {
      throw new ForbiddenException('User not authenticated');
    }
    return this.usersService.findOne(userId);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Get user by ID (admin only)' })
  public async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<unknown> {
    return this.usersService.findOne(id);
  }

  @ApiOperation({ summary: 'Update own profile' })
  public async updateProfile(
    @Request() req: UserRequest,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<unknown> {
    const userId = req.user?.userId;
    if (!userId) {
      throw new ForbiddenException('User not authenticated');
    }
    return this.usersService.update(userId, updateUserDto);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('admin')
  @ApiOperation({ summary: 'Update user (admin only)' })
  public async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateUserDto: UpdateUserDto,
  ): Promise<unknown> {
    return this.usersService.update(id, updateUserDto);
  }

  @Post('me/profile-picture')
  @Throttle({ default: THROTTLE.FILE_UPLOAD })
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Upload profile picture' })
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
    if (!userId) {
      throw new ForbiddenException('User not authenticated');
    }
    return this.usersService.uploadProfilePicture(userId, file);
  }

  @ApiOperation({ summary: 'Delete own account' })
  public async deleteOwnAccount(@Request() req: UserRequest): Promise<unknown> {
    const userId = req.user?.userId;
    if (!userId) {
      throw new ForbiddenException('User not authenticated');
    }
    return this.usersService.remove(userId);
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
    if (!userId) {
      throw new ForbiddenException('User not authenticated');
    }
    if(id === userId) {
      throw new ForbiddenException(
        'Cannot delete your own account through admin endpoint. Use DELETE /users/me instead.',
      );
    }
    return this.usersService.remove(id);
  }
}
