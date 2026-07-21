import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, QueryFailedError, Repository } from 'typeorm';
import { toSeoulIso } from '../../common/utils/date.util';
import { JwtTokenService } from '../../integrations/jwt/jwt-token.service';
import { AiChatSession } from '../ai-chat-sessions/entity/ai-chat-session.entity';
import { AUTH_ERROR, throwAuthError } from './constants/auth-error.constants';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { RefreshToken } from './entity/refresh-token.entity';
import { User } from './entity/user.entity';
const AI_CHAT_SESSION_STATUS_ACTIVE = 'ACTIVE';
const AI_CHAT_PROVIDER = 'openai';

export interface CheckNicknameResult {
  isAvailable: boolean;
}

export interface SignupResult {
  userId: string;
  loginId: string;
  nickname: string;
  email: string | null;
  createdAt: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: {
    userId: string;
    loginId: string;
    nickname: string;
    email: string | null;
  };
}

export interface RefreshTokenResult {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: Repository<RefreshToken>,
    @InjectRepository(AiChatSession)
    private readonly aiChatSessionRepository: Repository<AiChatSession>,
    private readonly jwtTokenService: JwtTokenService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async checkNickname(nickname: string): Promise<CheckNicknameResult> {
    const existing = await this.userRepository.findOne({ where: { nickname } });
    return { isAvailable: existing === null };
  }

  async signup(dto: SignupDto): Promise<SignupResult> {
    await this.assertNicknameAvailable(dto.nickname);

    const existingLoginId = await this.userRepository.findOne({
      where: { loginId: dto.loginId },
    });
    if (existingLoginId) {
      throwAuthError(
        AUTH_ERROR.LOGIN_ID_CONFLICT,
        'loginId already exists',
        HttpStatus.CONFLICT,
      );
    }

    if (dto.email) {
      const existingEmail = await this.userRepository.findOne({
        where: { email: dto.email },
      });
      if (existingEmail) {
        throwAuthError(
          AUTH_ERROR.EMAIL_CONFLICT,
          'email already exists',
          HttpStatus.CONFLICT,
        );
      }
    }

    const llmModel =
      this.configService.get<string>('llm.model') ?? 'gpt-5_4-mini-2026-03-17';

    try {
      return await this.dataSource.transaction(async (manager) => {
        const userRepo = manager.getRepository(User);
        const sessionRepo = manager.getRepository(AiChatSession);

        const user = userRepo.create({
          loginId: dto.loginId,
          nickname: dto.nickname,
          passwordHash: dto.passwordHash,
          email: dto.email ?? null,
        });
        const savedUser = await userRepo.save(user);

        const existingSession = await sessionRepo.findOne({
          where: { requesterUserId: savedUser.id },
        });
        if (!existingSession) {
          const session = sessionRepo.create({
            requesterUserId: savedUser.id,
            gameRoomId: null,
            providerConversationId: null,
            provider: AI_CHAT_PROVIDER,
            llmModel,
            status: AI_CHAT_SESSION_STATUS_ACTIVE,
            closedAt: null,
          });
          await sessionRepo.save(session);
        }

        return {
          userId: savedUser.id,
          loginId: savedUser.loginId,
          nickname: savedUser.nickname,
          email: savedUser.email,
          createdAt: toSeoulIso(savedUser.createdAt),
        };
      });
    } catch (error) {
      this.rethrowUniqueViolation(error);
      throw error;
    }
  }

  async login(dto: LoginDto): Promise<LoginResult> {
    const user = await this.userRepository.findOne({
      where: { loginId: dto.loginId },
    });

    if (!user || user.passwordHash !== dto.passwordHash) {
      throwAuthError(
        AUTH_ERROR.INVALID_CREDENTIALS,
        'Invalid loginId or password',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const tokens = await this.issueTokens(user);
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        userId: user.id,
        loginId: user.loginId,
        nickname: user.nickname,
        email: user.email,
      },
    };
  }

  async refreshToken(refreshToken: string): Promise<RefreshTokenResult> {
    const tokenHash = this.jwtTokenService.hashRefreshToken(refreshToken);

    return this.dataSource.transaction(async (manager) => {
      const refreshRepo = manager.getRepository(RefreshToken);
      const userRepo = manager.getRepository(User);

      const stored = await refreshRepo.findOne({
        where: { tokenHash },
        relations: ['user'],
      });

      if (!stored || stored.revokedAt !== null) {
        throwAuthError(
          AUTH_ERROR.REFRESH_TOKEN_REVOKED,
          'Refresh token has been revoked',
          HttpStatus.UNAUTHORIZED,
        );
      }

      if (stored.expiresAt.getTime() <= Date.now()) {
        throwAuthError(
          AUTH_ERROR.TOKEN_INVALID,
          'Refresh token has expired',
          HttpStatus.UNAUTHORIZED,
        );
      }

      const user = stored.user ?? (await userRepo.findOneBy({ id: stored.userId }));
      if (!user) {
        throwAuthError(
          AUTH_ERROR.TOKEN_INVALID,
          'Refresh token is invalid',
          HttpStatus.UNAUTHORIZED,
        );
      }

      const revokeResult = await refreshRepo.update(
        { id: stored.id, revokedAt: IsNull() },
        { revokedAt: new Date() },
      );

      if (!revokeResult.affected) {
        throwAuthError(
          AUTH_ERROR.REFRESH_TOKEN_REVOKED,
          'Refresh token has been revoked',
          HttpStatus.UNAUTHORIZED,
        );
      }

      const tokens = await this.persistRefreshToken(user, refreshRepo);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      };
    });
  }

  private async assertNicknameAvailable(nickname: string): Promise<void> {
    const existing = await this.userRepository.findOne({ where: { nickname } });
    if (existing) {
      throwAuthError(
        AUTH_ERROR.NICKNAME_CONFLICT,
        'nickname already exists',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async issueTokens(user: User): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = this.jwtTokenService.signAccessToken({
      sub: user.id,
      loginId: user.loginId,
    });
    const refreshToken = this.jwtTokenService.generateRefreshToken();
    const tokenHash = this.jwtTokenService.hashRefreshToken(refreshToken);

    await this.refreshTokenRepository.save(
      this.refreshTokenRepository.create({
        userId: user.id,
        tokenHash,
        expiresAt: this.jwtTokenService.getRefreshExpiresAt(),
        revokedAt: null,
      }),
    );

    return { accessToken, refreshToken };
  }

  private async persistRefreshToken(
    user: User,
    refreshRepo: Repository<RefreshToken>,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const accessToken = this.jwtTokenService.signAccessToken({
      sub: user.id,
      loginId: user.loginId,
    });
    const refreshToken = this.jwtTokenService.generateRefreshToken();
    const tokenHash = this.jwtTokenService.hashRefreshToken(refreshToken);

    await refreshRepo.save(
      refreshRepo.create({
        userId: user.id,
        tokenHash,
        expiresAt: this.jwtTokenService.getRefreshExpiresAt(),
        revokedAt: null,
      }),
    );

    return { accessToken, refreshToken };
  }

  private rethrowUniqueViolation(error: unknown): void {
    if (!(error instanceof QueryFailedError)) {
      return;
    }

    const driverError = error.driverError as { code?: string; constraint?: string };
    if (driverError.code !== '23505') {
      return;
    }

    const constraint = driverError.constraint ?? '';
    if (constraint.includes('login_id')) {
      throwAuthError(
        AUTH_ERROR.LOGIN_ID_CONFLICT,
        'loginId already exists',
        HttpStatus.CONFLICT,
      );
    }
    if (constraint.includes('nickname')) {
      throwAuthError(
        AUTH_ERROR.NICKNAME_CONFLICT,
        'nickname already exists',
        HttpStatus.CONFLICT,
      );
    }
    if (constraint.includes('email')) {
      throwAuthError(
        AUTH_ERROR.EMAIL_CONFLICT,
        'email already exists',
        HttpStatus.CONFLICT,
      );
    }
  }
}
