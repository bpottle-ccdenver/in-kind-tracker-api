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
import { router as userAccountRouter } from '../routes/userAccount.js';
import { performRequest, resetPoolMocks } from './testUtils/requestUtils.js';

function createTestApp(user = { user_id: 1000 }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(
    '/user-account',
    requirePermissions({ read: 'manage users', manage: 'manage users' }),
    userAccountRouter,
  );
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetPoolMocks(pool);
});

let consoleErrorSpy;
beforeAll(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  consoleErrorSpy.mockRestore();
});

describe('User account routes', () => {
  test('GET /user-account denies access without permission', async () => {
    pool.query.mockImplementationOnce(async () => ({ rows: [] }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/user-account' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  test('GET /user-account returns normalized users', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [
          {
            user_id: 1,
            role_id: 2,
            role_name: 'Admin',
            default_route: '/Dashboard',
            username: 'admin@example.com',
            name: 'Admin',
            status: 'active',
          },
        ],
      }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/user-account' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        user_id: 1,
        role_id: 2,
        role_name: 'Admin',
        role: 'Admin',
        app_role: 'Admin',
        default_route: '/Dashboard',
        username: 'admin@example.com',
        name: 'Admin',
        status: 'active',
      },
    ]);
  });

  test('POST /user-account validates email', async () => {
    pool.query.mockImplementationOnce(async () => ({
      rows: [{ permission: 'manage users' }],
    }));

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/user-account',
      body: { username: 'not-an-email' },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'username must be a valid email address' });
  });

  test('POST /user-account inserts user and prevents SQL injection in name', async () => {
    const injection = `Robert'); DROP TABLE in_kind_tracker.user_account; --`;

    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async (sql, params) => {
        expect(sql).toContain('INSERT INTO in_kind_tracker.user_account');
        expect(sql).not.toContain(injection);
        expect(params[1]).toBe(injection);
        return { rows: [{ user_id: 20 }] };
      })
      .mockImplementationOnce(async () => ({
        rows: [
          {
            user_id: 20,
            username: 'safe@example.com',
            name: injection,
            status: 'pending',
            role_name: null,
            default_route: null,
          },
        ],
      }));

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/user-account',
      body: { username: 'safe@example.com', name: injection },
    });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe(injection);
  });

  test('GET /user-account/:id resists SQL injection in path', async () => {
    const injection = `15; DROP TABLE in_kind_tracker.user_account; --`;

    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async (sql, params) => {
        expect(sql).not.toContain(injection);
        expect(params).toHaveLength(1);
        expect(Number.isNaN(params[0])).toBe(true);
        return { rows: [] };
      });

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: `/user-account/${encodeURIComponent(injection)}` });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
  });

  test('PATCH /user-account updates name', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async (sql, params) => {
        expect(sql).toContain('UPDATE in_kind_tracker.user_account');
        expect(params).toEqual(['Updated Name', 3]);
        return { rows: [{ user_id: 3 }] };
      })
      .mockImplementationOnce(async () => ({
        rows: [
          {
            user_id: 3,
            username: 'user@example.com',
            name: 'Updated Name',
            status: 'active',
            role_name: 'Admin',
            default_route: '/Dashboard',
          },
        ],
      }));

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'PATCH',
      path: '/user-account/3',
      body: { name: 'Updated Name' },
    });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
  });

  test('PATCH /user-account handles duplicate username', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async () => {
        const err = new Error('duplicate');
        err.code = '23505';
        throw err;
      });

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'PATCH',
      path: '/user-account/3',
      body: { username: 'duplicate@example.com' },
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A user with that username already exists.' });
  });

  test('PATCH /user-account rejects last_login_at update', async () => {
    pool.query.mockImplementationOnce(async () => ({
      rows: [{ permission: 'manage users' }],
    }));

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'PATCH',
      path: '/user-account/3',
      body: { last_login_at: '2024-06-20' },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'last_login_at is managed by the system and cannot be updated manually' });
  });
});
