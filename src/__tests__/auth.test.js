import express from 'express';

jest.mock('../db.js', () => {
  const query = jest.fn();
  const connect = jest.fn();
  return {
    pool: { query, connect },
    assertDbConnection: jest.fn(),
  };
});

jest.mock('../middleware/authorization.js', () => {
  const actual = jest.requireActual('../middleware/authorization.js');
  return {
    ...actual,
    listUserPermissions: jest.fn(),
  };
});

import { pool } from '../db.js';
import { listUserPermissions } from '../middleware/authorization.js';
import { router as authRouter } from '../routes/auth.js';
import { performRequest, resetPoolMocks } from './testUtils/requestUtils.js';

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetPoolMocks(pool);
});

describe('Auth routes', () => {
  test('POST /auth/login validates user_id as integer', async () => {
    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/auth/login',
      body: { user_id: '1; DROP TABLE users;' },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'user_id is required.' });
  });

  test('POST /auth/login returns 404 when user not found', async () => {
    const clientQuery = jest.fn(async (sql) => {
      if (sql.trim().toUpperCase() === 'BEGIN') return { rows: [] };
      if (sql.includes('SELECT ua.*, r.role_name')) return { rows: [] };
      if (sql.trim().toUpperCase() === 'ROLLBACK') return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const release = jest.fn();
    pool.connect.mockResolvedValue({ query: clientQuery, release });

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/auth/login',
      body: { user_id: 99 },
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'User not found' });
    expect(clientQuery).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  test('POST /auth/login rejects inactive users', async () => {
    const clientQuery = jest.fn(async (sql) => {
      const normalized = sql.trim().toUpperCase();
      if (normalized === 'BEGIN') return { rows: [] };
      if (normalized === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT ua.*, r.role_name')) {
        return {
          rows: [
            {
              user_id: 10,
              username: 'inactive@example.com',
              name: 'Inactive User',
              status: 'inactive',
              role_id: 2,
              role_name: 'Therapist',
              default_route: '/dashboard',
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const release = jest.fn();
    pool.connect.mockResolvedValue({ query: clientQuery, release });

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/auth/login',
      body: { user_id: 10 },
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'User account is inactive' });
    expect(listUserPermissions).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  test('POST /auth/login succeeds and sets cookie', async () => {
    listUserPermissions.mockResolvedValue(['manage users']);
    const clientQuery = jest.fn(async (sql, params) => {
      const normalized = sql.trim().toUpperCase();
      if (normalized === 'BEGIN' || normalized === 'COMMIT') {
        return { rows: [] };
      }
      if (sql.includes('SELECT ua.*, r.role_name')) {
        return {
          rows: [
            {
              user_id: 3,
              username: 'user@example.com',
              name: 'User',
              status: 'active',
              role_id: 2,
              role_name: 'Admin',
              default_route: '/Dashboard',
            },
          ],
        };
      }
      if (sql.includes('UPDATE in_kind_tracker.user_account')) {
        expect(params).toEqual([3]);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO in_kind_tracker.user_session')) {
        expect(params[1]).toBe(3);
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const release = jest.fn();
    pool.connect.mockResolvedValue({ query: clientQuery, release });

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/auth/login',
      body: { user_id: 3 },
    });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('user@example.com');
    expect(res.body.permissions).toEqual(['manage users']);
    expect(res.cookies).toHaveProperty('pp_session');
    expect(res.cookies.pp_session.value).toBeDefined();
    expect(release).toHaveBeenCalled();
  });

  test('POST /auth/logout clears session cookie', async () => {
    pool.query.mockImplementationOnce(async () => ({
      rows: [],
    }));

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/auth/logout',
      headers: { cookie: 'pp_session=session-value' },
    });

    expect(res.status).toBe(204);
    expect(res.cookies.pp_session).toEqual({
      cleared: true,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
      },
    });
  });

  test('GET /auth/users resists SQL injection in status filter', async () => {
    const injection = `active'); DROP TABLE in_kind_tracker.user_account; --`;

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'GET',
      path: `/auth/users?status=${encodeURIComponent(injection)}`,
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid status values: active\'); drop table in_kind_tracker.user_account; --' });
    expect(pool.query).not.toHaveBeenCalled();
  });
});
