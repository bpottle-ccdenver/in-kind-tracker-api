import express from 'express';

jest.mock('../db.js', () => {
  const query = jest.fn();
  const connect = jest.fn();
  return {
    pool: { query, connect },
    assertDbConnection: jest.fn(),
  };
});

import { pool } from '../db.js';
import { requirePermissions } from '../middleware/authorization.js';
import { router as permissionRouter } from '../routes/permission.js';
import { performRequest, resetPoolMocks } from './testUtils/requestUtils.js';

function createTestApp(user = { user_id: 950 }) {
  const app = express();
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/permission', requirePermissions({ read: 'manage users', manage: 'manage users' }), permissionRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetPoolMocks(pool);
});

describe('Permission routes', () => {
  test('GET /permission denies access without permission', async () => {
    pool.query.mockImplementationOnce(async () => ({ rows: [] }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/permission' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  test('GET /permission lists permissions', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [
          { permission_id: 1, permission: 'manage users' },
          { permission_id: 2, permission: 'view users' },
        ],
      }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/permission' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { permission_id: 1, permission: 'manage users' },
      { permission_id: 2, permission: 'view users' },
    ]);
  });

  test('GET /permission handles database errors', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async () => {
        throw new Error('db failure');
      });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/permission' });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
