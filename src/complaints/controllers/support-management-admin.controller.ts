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
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { GetUser } from '../../common/decorators/get-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import {
  SupportResourceFilterDto,
  UpsertCannedResponseDto,
  UpsertKnowledgeArticleDto,
  UpsertSupportSlaPolicyDto,
} from '../dto/support-management.dto';
import { SupportManagementService } from '../support-management.service';

@Controller('admin/call-center')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class SupportManagementAdminController {
  constructor(private readonly service: SupportManagementService) {}
  @Get('sla-policy') getPolicy() {
    return this.service.adminPolicy();
  }
  @Put('sla-policy') putPolicy(
    @Body() dto: UpsertSupportSlaPolicyDto,
    @GetUser() user: JwtPayload,
  ) {
    return this.service.upsertPolicy(dto, user.userId);
  }
  @Delete('sla-policy') async deletePolicy(@GetUser() user: JwtPayload) {
    await this.service.removePolicy(user.userId);
    return { deleted: true };
  }
  @Get('canned-responses') canned(@Query() filter: SupportResourceFilterDto) {
    return this.service.listCanned(filter, true);
  }
  @Post('canned-responses') createCanned(
    @Body() dto: UpsertCannedResponseDto,
    @GetUser() u: JwtPayload,
  ) {
    return this.service.saveCanned(null, dto, u.userId);
  }
  @Put('canned-responses/:id') updateCanned(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertCannedResponseDto,
    @GetUser() u: JwtPayload,
  ) {
    return this.service.saveCanned(id, dto, u.userId);
  }
  @Delete('canned-responses/:id') async deleteCanned(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() u: JwtPayload,
  ) {
    await this.service.removeCanned(id, u.userId);
    return { deleted: true };
  }
  @Get('knowledge-base') articles(@Query() filter: SupportResourceFilterDto) {
    return this.service.listArticles(filter, true);
  }
  @Post('knowledge-base') createArticle(
    @Body() dto: UpsertKnowledgeArticleDto,
    @GetUser() u: JwtPayload,
  ) {
    return this.service.saveArticle(null, dto, u.userId);
  }
  @Put('knowledge-base/:id') updateArticle(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertKnowledgeArticleDto,
    @GetUser() u: JwtPayload,
  ) {
    return this.service.saveArticle(id, dto, u.userId);
  }
  @Delete('knowledge-base/:id') async deleteArticle(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() u: JwtPayload,
  ) {
    await this.service.removeArticle(id, u.userId);
    return { deleted: true };
  }
}
