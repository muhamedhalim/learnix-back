import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { HybridAuthGuard } from '../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { QuestionFilterDto } from '../dto';
import { QuestionBankService } from '../services/question-bank.service';

/** Student discovery endpoint for standalone public practice questions. */
@ApiTags('Student · Question Bank')
@Controller('student/questions')
@UseGuards(HybridAuthGuard, RolesGuard)
@Roles('student')
@ApiBearerAuth('JWT-auth')
export class StudentQuestionsController {
  constructor(private readonly bank: QuestionBankService) {}

  @Get('question-bank')
  @ApiOperation({ summary: 'List standalone active public questions for practice' })
  public listPublic(@Query() filter: QuestionFilterDto) {
    return this.bank.findPublic(filter);
  }
}
