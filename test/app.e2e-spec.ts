import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import type { Server } from 'http';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './../src/app.module';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();

    app.setGlobalPrefix('api/v1');
    app.use('/', (req: Request, res: Response, next: NextFunction) => {
      if (req.url === '/') {
        return res.redirect('/api');
      }
      next();
    });

    await app.init();
  });

  it('/ (GET) should redirect to /api', () => {
    return request(app.getHttpServer() as Server)
      .get('/')
      .expect(302)
      .expect('Location', '/api');
  });

  it('/api/v1 (GET) should return Hello World!', () => {
    return request(app.getHttpServer() as Server)
      .get('/api/v1')
      .expect(200)
      .expect('Hello World!');
  });
});
