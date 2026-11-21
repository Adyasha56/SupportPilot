import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AdminLoginRequestSchema, AdminSessionBootstrap } from '@supportpilot/shared';
import { ChatRetryAfterFilter } from '../chat/chat-retry-after.filter';
import { AdminLoginService, GENERIC_INVALID_CREDENTIALS_MESSAGE } from './admin-login.service';
import { AdminSessionService } from './admin-session.service';
import { AdminAuthGuard, AdminPrincipal } from './admin-auth.guard';
import { CurrentAdminPrincipal } from './current-admin-principal.decorator';
import { adminAuthHttpError } from './admin-auth-http-error';
import { ALL_SESSION_COOKIE_NAMES, resolveSessionCookie } from './admin-session-cookie';
import { parseCookieHeader, readSessionCookieValue } from './cookie-utils';
import { ADMIN_AUTH_SETTINGS } from './admin-auth-settings.provider';
import { AdminAuthSettings } from './admin-auth.settings';

/**
 * Milestone 5, Stage 1b - `POST /v1/admin/login` is deliberately the ONLY
 * route in this controller with no `AdminAuthGuard` - it's the mechanism
 * that PRODUCES an authenticated principal, not something that requires
 * one. `GET /v1/admin/session` and `POST /v1/admin/logout` both require
 * it; `Cache-Control: no-store` on every response here comes from the
 * global `securityHeadersMiddleware` (common/security-headers.middleware.ts,
 * Stage 1a) - every non-widget-asset path already gets it, so nothing
 * extra is needed in this controller for item 5's requirement.
 */
@Controller('v1/admin')
@UseFilters(ChatRetryAfterFilter)
export class AdminLoginController {
  constructor(
    private readonly loginService: AdminLoginService,
    private readonly sessionService: AdminSessionService,
    @Inject(ADMIN_AUTH_SETTINGS) private readonly settings: AdminAuthSettings,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Req() request: Request, @Res({ passthrough: true }) response: Response, @Body() rawBody: unknown): Promise<{ ok: true }> {
    const parsed = AdminLoginRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw adminAuthHttpError('INVALID_REQUEST', 'The request body is invalid.');
    }

    const presentedRawSessionToken = readSessionCookieValue(parseCookieHeader(request.headers.cookie));
    const result = await this.loginService.login({
      email: parsed.data.email,
      password: parsed.data.password,
      clientIp: request.ip ?? request.socket.remoteAddress ?? 'unknown',
      presentedRawSessionToken,
    });

    switch (result.kind) {
      case 'rate_limited':
        throw adminAuthHttpError('RATE_LIMITED', 'Too many login attempts. Please try again shortly.', result.retryAfterSeconds);
      case 'hash_queue_full':
        throw adminAuthHttpError('HASH_QUEUE_FULL', 'The server is busy. Please try again shortly.', 2);
      case 'invalid_credentials':
        throw adminAuthHttpError('INVALID_CREDENTIALS', GENERIC_INVALID_CREDENTIALS_MESSAGE);
      case 'success': {
        const cookie = resolveSessionCookie(this.settings.devCookieEnabled, process.env.NODE_ENV);
        response.cookie(cookie.name, result.rawSessionToken, {
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          sameSite: cookie.sameSite,
          path: cookie.path,
          expires: result.absoluteExpiresAt,
        });
        return { ok: true };
      }
    }
  }

  @Get('session')
  @UseGuards(AdminAuthGuard)
  async session(@CurrentAdminPrincipal() principal: AdminPrincipal): Promise<AdminSessionBootstrap> {
    const result = await this.sessionService.getBootstrap(principal);
    if (result.kind !== 'ok') {
      throw adminAuthHttpError('INVALID_CREDENTIALS', 'Not a cookie-authenticated session.');
    }
    return {
      tenantId: result.tenantId,
      csrfToken: result.csrfToken,
      absoluteExpiresAt: result.absoluteExpiresAt.toISOString(),
      idleExpiresAt: result.idleExpiresAt.toISOString(),
    };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(AdminAuthGuard)
  async logout(@CurrentAdminPrincipal() principal: AdminPrincipal, @Res({ passthrough: true }) response: Response): Promise<void> {
    await this.sessionService.logout(principal);
    for (const name of ALL_SESSION_COOKIE_NAMES) {
      response.clearCookie(name, { path: '/' });
    }
  }
}
