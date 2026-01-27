import type { INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';

import { AppModule } from './../src/app.module';
import type { NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import * as request from 'supertest';

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
        res.redirect('/api');
        return;
      }
      next();
    });

    await app.init();
  });

  it('/ (GET) should redirect to /api', () => {
    return request(app.getHttpServer() as Server)
      .get('/')
      .expect(302)
      .expect('Location', '/api') as unknown;
  });

  it('/api/v1 (GET) should return Hello World!', () => {
    return request(app.getHttpServer() as Server)
      .get('/api/v1')
      .expect(200)
      .expect('Hello World!') as unknown;
  });
});
