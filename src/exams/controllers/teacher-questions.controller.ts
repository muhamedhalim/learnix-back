import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { CreateQuestionDto, QuestionFilterDto, UpdateQuestionDto } from '../dto';
import { QuestionBankService } from '../services/question-bank.service';

@ApiTags('Teacher · Question Bank')
@Controller('teacher/questions')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('teacher')
@ApiBearerAuth('JWT-auth')
export class TeacherQuestionsController {
  constructor(private readonly bank: QuestionBankService) {}

  @Post()
  @ApiOperation({ summary: 'Create a bank question' })
  public create(@GetUser() user: JwtPayload, @Body() dto: CreateQuestionDto) {
    return this.bank.create(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List/search my questions' })
  public list(@GetUser() user: JwtPayload, @Query() filter: QuestionFilterDto) {
    return this.bank.findMany(user.userId, filter);
  }

  @Get(':id')
  public findOne(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.bank.findOne(id, user.userId);
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Version history for a question' })
  public versions(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    return this.bank.getVersions(id, user.userId);
  }

  @Put(':id')
  public update(
    @GetUser() user: JwtPayload,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateQuestionDto,
  ) {
    return this.bank.update(id, user.userId, dto);
  }

  @Delete(':id')
  public async remove(@GetUser() user: JwtPayload, @Param('id', ParseUUIDPipe) id: string) {
    await this.bank.remove(id, user.userId);
    return { message: 'Question deleted' };
  }
}
