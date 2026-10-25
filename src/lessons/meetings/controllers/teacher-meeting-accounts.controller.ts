import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Body,
  HttpException,
  Param,
  ParseEnumPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';

import type { Request, Response } from 'express';

import { HybridAuthGuard } from '../../../auth/guards/hybrid-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { GetUser } from '../../../common/decorators/get-user.decorator';
import { Roles } from '../../../common/decorators/roles.decorator';
import { buildAbsoluteUrl, getConfiguredPublicOrigin } from '../../../config/public-url.util';
import type { JwtPayload } from '../../../common/interfaces/user-request.interface';
import { MeetingProvider } from '../../entities/meeting-provider.enum';
import { MeetingAccountsService } from '../meeting-accounts.service';
import { ConnectMeetingAccountDto, MEETING_CONNECT_LOCALES } from '../dto/connect-meeting-account.dto';
import { toMeetingAccountSummaryDto, type MeetingAccountSummaryDto } from '../dto/meeting-account-summary.dto';

/**
 * Binds an OAuth handshake to the browser that started it. `connect` (an
 * authenticated XHR) sets this signed HttpOnly cookie to the handshake nonce;
 * the provider redirect back to `callback` must carry it. Without it, an
 * attacker could start a handshake, hand the authorize URL to a victim, and
 * have the VICTIM's provider account linked to the attacker's teacher account.
 *
 * Lax is deliberate: it is sent on the top-level GET redirect from the provider
 * and is never sent on cross-site subrequests. It requires the API and the web
 * app to be same-site, as the auth cookies' own deployment already assumes.
 */
export const MEETING_OAUTH_COOKIE = 'lx_meeting_oauth';
const MEETING_OAUTH_COOKIE_PATH = '/api/v1/teacher/meeting-accounts';
const MEETING_OAUTH_COOKIE_MAX_AGE_MS = 10 * 60 * 1000;

/** Stable, non-sensitive failure reason shown to the teacher after the redirect. */
function connectFailureReason(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    const code = typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
    if (code === 'MEETING_OAUTH_BINDING') return 'binding';
    if (code === 'MEETING_ACCOUNT_MISMATCH') return 'mismatch';
    if (error.getStatus() === HttpStatus.CONFLICT) return 'replay';
    if (error.getStatus() === HttpStatus.BAD_REQUEST) return 'invalid';
  }
  return 'failed';
}

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
    @Body() dto: ConnectMeetingAccountDto,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): { authorize_url: string } {
    const { authorizeUrl, nonce } = this.accounts.startConnect(user.userId, provider, dto.locale);
    res.cookie(MEETING_OAUTH_COOKIE, nonce, {
      httpOnly: true,
      signed: true,
      sameSite: 'lax',
      secure: process.env['NODE_ENV'] === 'production' || request.secure,
      path: MEETING_OAUTH_COOKIE_PATH,
      maxAge: MEETING_OAUTH_COOKIE_MAX_AGE_MS,
    });
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
    @Req() request: Request,
    @Res() res: Response,
  ): Promise<void> {
    const frontendUrl = getConfiguredPublicOrigin(
      (key) => this.configService.get<string>(key),
      'FRONTEND_URL',
      'http://localhost:3000',
    );
    // `as-needed` locale routing: the default locale (en) is unprefixed.
    const locale = this.accounts.localeFromState(state);
    const localePrefix =
      locale && locale !== 'en' && (MEETING_CONNECT_LOCALES as readonly string[]).includes(locale)
        ? `/${locale}`
        : '';
    const integrationsUrl = buildAbsoluteUrl(frontendUrl, `${localePrefix}/teacher/integrations`);

    // One-shot: whatever happens next, this browser's binding is spent.
    const bindingCookie: unknown = (request.signedCookies as Record<string, unknown> | undefined)?.[
      MEETING_OAUTH_COOKIE
    ];
    res.clearCookie(MEETING_OAUTH_COOKIE, { path: MEETING_OAUTH_COOKIE_PATH });

    if (providerError || !state || !code) {
      const reason = providerError === 'access_denied' ? 'denied' : 'failed';
      res.redirect(`${integrationsUrl}?meeting_connect=error&reason=${reason}`);
      return;
    }
    try {
      const summary = await this.accounts.completeConnect(
        state,
        code,
        typeof bindingCookie === 'string' ? bindingCookie : undefined,
      );
      res.redirect(`${integrationsUrl}?meeting_connect=success&provider=${summary.provider}`);
    } catch (error) {
      res.redirect(`${integrationsUrl}?meeting_connect=error&reason=${connectFailureReason(error)}`);
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
