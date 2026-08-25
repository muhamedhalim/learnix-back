import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';

import type { Response } from 'express';

import { HybridAuthGuard } from '../../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { buildAbsoluteUrl, getConfiguredPublicOrigin } from '../../../config/public-url.util';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { MeetingProvider } from '../../entities/meeting-provider.enum';
import { MeetingAccountsService } from '../meeting-accounts.service';
import { toMeetingAccountSummaryDto, type MeetingAccountSummaryDto } from '../dto/meeting-account-summary.dto';

@ApiTags('Teacher Meeting Accounts')
@Controller('teacher/meeting-accounts')
export class TeacherMeetingAccountsController {
  public constructor(
    private readonly accounts: MeetingAccountsService,
    private readonly configService: ConfigService,
  ) {}

  @Get()
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('teacher')
  @ApiBearerAuth('JWT-auth')
  public async list(@GetUser() user: JwtPayload): Promise<MeetingAccountSummaryDto[]> {
    const summaries = await this.accounts.list(user.userId);
    return summaries.map(toMeetingAccountSummaryDto);
  }

  @Post(':provider/connect')
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('teacher')
  @ApiBearerAuth('JWT-auth')
  public connect(
    @GetUser() user: JwtPayload,
    @Param('provider', new ParseEnumPipe(MeetingProvider)) provider: MeetingProvider,
  ): { authorize_url: string } {
    const { authorizeUrl } = this.accounts.startConnect(user.userId, provider);
    return { authorize_url: authorizeUrl };
  }

  /**
   * The provider redirects the teacher's browser here directly — it carries
   * no app session, only the signed `state` this same service issued in
   * `connect()` above, which is what actually authorizes this request (see
   * `MeetingAccountsService.verifyState`). Unguarded by design; never trust
   * `code`/`state` beyond what `completeConnect` cryptographically verifies.
   */
  @Get('callback')
  @ApiExcludeEndpoint()
  public async callback(
    @Query('state') state: string,
    @Query('code') code: string,
    @Query('error') providerError: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const frontendUrl = getConfiguredPublicOrigin(
      (key) => this.configService.get<string>(key),
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    const integrationsUrl = buildAbsoluteUrl(frontendUrl, '/teacher/integrations');

    if (providerError || !state || !code) {
      res.redirect(`${integrationsUrl}?meeting_connect=error`);
      return;
    }
    try {
      const summary = await this.accounts.completeConnect(state, code);
      res.redirect(`${integrationsUrl}?meeting_connect=success&provider=${summary.provider}`);
    } catch {
      res.redirect(`${integrationsUrl}?meeting_connect=error`);
    }
  }

  @Delete(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(HybridAuthGuard, RolesGuard)
  @Roles('teacher')
  @ApiBearerAuth('JWT-auth')
  public async disconnect(
    @GetUser() user: JwtPayload,
    @Param('provider', new ParseEnumPipe(MeetingProvider)) provider: MeetingProvider,
  ): Promise<void> {
    await this.accounts.disconnect(user.userId, provider);
  }
}
