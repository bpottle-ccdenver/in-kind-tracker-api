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
import { router as allowedPermissionsRouter } from '../routes/allowedPermissions.js';
import { performRequest, resetPoolMocks } from './testUtils/requestUtils.js';

function createTestApp(user = { user_id: 960 }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(
    '/allowed-permissions',
    requirePermissions({ read: 'manage users', manage: 'manage users' }),
    allowedPermissionsRouter,
  );
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetPoolMocks(pool);
});

describe('Allowed permissions routes', () => {
  test('GET /allowed-permissions denies access without permission', async () => {
    pool.query.mockImplementationOnce(async () => ({ rows: [] }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/allowed-permissions?username=jane' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  test('GET /allowed-permissions requires username', async () => {
    pool.query.mockImplementationOnce(async () => ({
      rows: [{ permission: 'manage users' }],
    }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/allowed-permissions' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'username query parameter is required' });
  });

  test('GET /allowed-permissions returns permissions', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async (sql, params) => {
        expect(sql).toContain('WHERE ua.username = $1');
        expect(params).toEqual(['jane.doe']);
        return {
          rows: [
            { permission: 'manage users' },
            { permission: 'view users' },
          ],
        };
      });

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/allowed-permissions?username=Jane.Doe ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      username: 'jane.doe',
      permissions: ['manage users', 'view users'],
    });
  });

  test('GET /allowed-permissions handles SQL injection attempt', async () => {
    const injection = `admin'); DROP TABLE in_kind_tracker.permission; --`;

    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async (sql, params) => {
        expect(sql).not.toContain(injection);
        expect(params).toEqual([injection.trim().toLowerCase()]);
        return { rows: [] };
      });

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'GET',
      path: `/allowed-permissions?username=${encodeURIComponent(injection)}`,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: injection.trim().toLowerCase(), permissions: [] });
  });

  test('GET /allowed-permissions surfaces database error', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async () => {
        throw new Error('db failure');
      });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'GET',
      path: '/allowed-permissions?username=test',
    });

    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
