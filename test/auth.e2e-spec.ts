import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

import { AppModule } from '../src/app.module';
import type { Server } from 'http';
import * as request from 'supertest';
import { DataSource } from 'typeorm';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let accessToken: string;
  let refreshToken: string;

  const testUser = {
    email: 'e2e.test@example.com',
    password: 'Test123456!',
    username: 'e2euser',
    full_name: 'E2E Test User',
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    dataSource = moduleFixture.get<DataSource>(DataSource);
  });

  afterAll(async () => {
    // Clean up test user
    await dataSource.query('DELETE FROM users WHERE email = $1', [
      testUser.email,
    ]);
    await app.close();
  });

  describe('/auth/csrf-token (GET)', () => {
    it('should return CSRF token response', () => {
      return request(app.getHttpServer() as Server)
        .get('/api/v1/auth/csrf-token')
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('message');
          expect(res.body.message).toContain('CSRF token');
          // token might be undefined on first call, which is expected
        }) as unknown;
    });
  });

  describe('/auth/register (POST)', () => {
    it('should successfully register a new user', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/register')
        .send(testUser)
        .expect(201)
        .expect((res) => {
          expect(res.body).toHaveProperty('access_token');
          expect(res.body).toHaveProperty('refresh_token');
          expect(res.body).toHaveProperty('user');
          expect(res.body.user.email).toBe(testUser.email);
          expect(res.body.user.username).toBe(testUser.username);
          expect(res.body.user.roles).toContain('student');

          accessToken = res.body.access_token;
          refreshToken = res.body.refresh_token;
        }) as unknown;
    });

    it('should fail to register with duplicate email', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/register')
        .send(testUser)
        .expect(409)
        .expect((res) => {
          expect(res.body.message).toContain('already exists');
        }) as unknown;
    });

    it('should fail to register with invalid email format', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/register')
        .send({
          email: 'invalid-email',
          password: 'Test123456!',
          username: 'testuser2',
          full_name: 'Test User 2',
        })
        .expect(400) as unknown;
    });

    it('should fail to register with weak password', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/register')
        .send({
          email: 'test2@example.com',
          password: '123',
          username: 'testuser3',
          full_name: 'Test User 3',
        })
        .expect(400) as unknown;
    });
  });

  describe('/auth/login (POST)', () => {
    it('should successfully login with valid credentials', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password,
        })
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('access_token');
          expect(res.body).toHaveProperty('refresh_token');
          expect(res.body).toHaveProperty('user');
          expect(res.body.user.email).toBe(testUser.email);

          accessToken = res.body.access_token;
          refreshToken = res.body.refresh_token;
        }) as unknown;
    });

    it('should fail to login with invalid password', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: 'WrongPassword123!',
        })
        .expect(401)
        .expect((res) => {
          expect(res.body.message).toBe('Invalid credentials');
        }) as unknown;
    });

    it('should fail to login with non-existent email', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({
          email: 'nonexistent@example.com',
          password: 'Password123!',
        })
        .expect(401)
        .expect((res) => {
          expect(res.body.message).toBe('Invalid credentials');
        }) as unknown;
    });

    it('should fail to login with missing fields', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
        })
        .expect(400) as unknown;
    });
  });

  describe('/auth/refresh (POST)', () => {
    it('should successfully refresh tokens with valid refresh token', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({
          refresh_token: refreshToken,
        })
        .expect(200)
        .expect((res) => {
          expect(res.body).toHaveProperty('access_token');
          expect(res.body).toHaveProperty('refresh_token');
          expect(res.body).toHaveProperty('user');
          expect(res.body.user.email).toBe(testUser.email);

          // Token rotation: new tokens should be different
          expect(res.body.access_token).not.toBe(accessToken);
          expect(res.body.refresh_token).not.toBe(refreshToken);

          accessToken = res.body.access_token;
          refreshToken = res.body.refresh_token;
        }) as unknown;
    });

    it('should fail to refresh with invalid refresh token', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({
          refresh_token: 'invalid_refresh_token_12345',
        })
        .expect(401)
        .expect((res) => {
          expect(res.body.message).toBe('Invalid refresh token');
        }) as unknown;
    });

    it('should fail to refresh with missing refresh token', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({})
        .expect(400) as unknown;
    });
  });

  describe('/auth/logout (POST)', () => {
    it('should successfully logout and invalidate refresh token', async () => {
      // First, logout
      (await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.message).toBe('Logged out successfully');
        })) as unknown;

      // Then, try to use the old refresh token (should fail)
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({
          refresh_token: refreshToken,
        })
        .expect(401) as unknown;
    });

    it('should fail to logout without authentication', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/logout')
        .expect(401) as unknown;
    });

    it('should fail to logout with invalid token', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/logout')
        .set('Authorization', 'Bearer invalid_token')
        .expect(401) as unknown;
    });
  });

  describe('Token Expiration and Rotation', () => {
    let newAccessToken: string;
    let newRefreshToken: string;

    beforeAll(async () => {
      // Login to get fresh tokens
      const response = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password,
        });

      newAccessToken = response.body.access_token;
      newRefreshToken = response.body.refresh_token;
    });

    it('should implement token rotation on refresh', async () => {
      const firstRefresh = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({
          refresh_token: newRefreshToken,
        })
        .expect(200);

      const firstNewAccessToken = firstRefresh.body.access_token;
      const firstNewRefreshToken = firstRefresh.body.refresh_token;

      // Verify new tokens are different
      expect(firstNewAccessToken).not.toBe(newAccessToken);
      expect(firstNewRefreshToken).not.toBe(newRefreshToken);

      // Old refresh token should now be invalid
      await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({
          refresh_token: newRefreshToken,
        })
        .expect(401);

      // New refresh token should work
      const secondRefresh = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/refresh')
        .send({
          refresh_token: firstNewRefreshToken,
        })
        .expect(200);

      expect(secondRefresh.body.access_token).not.toBe(firstNewAccessToken);
      expect(secondRefresh.body.refresh_token).not.toBe(firstNewRefreshToken);
    });
  });

  describe('Protected Routes', () => {
    let validAccessToken: string;

    beforeAll(async () => {
      // Login to get a valid token
      const response = await request(app.getHttpServer() as Server)
        .post('/api/v1/auth/login')
        .send({
          email: testUser.email,
          password: testUser.password,
        });

      validAccessToken = response.body.access_token;
    });

    it('should access protected route with valid token', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${validAccessToken}`)
        .expect(200) as unknown;
    });

    it('should fail to access protected route without token', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/logout')
        .expect(401) as unknown;
    });

    it('should fail to access protected route with malformed token', () => {
      return request(app.getHttpServer() as Server)
        .post('/api/v1/auth/logout')
        .set('Authorization', 'InvalidTokenFormat')
        .expect(401) as unknown;
    });
  });
});
