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
import { router as roleRouter } from '../routes/role.js';
import { performRequest, resetPoolMocks } from './testUtils/requestUtils.js';

function createTestApp(user = { user_id: 101 }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use('/role', requirePermissions({ read: 'manage users', manage: 'manage users' }), roleRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetPoolMocks(pool);
});

describe('Role routes', () => {
  test('GET /role denies access without manage permission', async () => {
    pool.query.mockImplementationOnce(async () => ({ rows: [] }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/role' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('GET /role returns roles when permission granted', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [
          {
            role_id: 1,
            role_name: 'Admin',
            default_route: '/Dashboard',
            permissions: [{ permission_id: 2, permission: 'manage users' }],
          },
        ],
      }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/role' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        role_id: 1,
        role_name: 'Admin',
        default_route: '/Dashboard',
        permissions: [{ permission_id: 2, permission: 'manage users' }],
      },
    ]);
  });

  test('POST /role creates a role when permission granted', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [
          {
            role_id: 42,
            role_name: 'QA',
            default_route: null,
            permissions: [{ permission_id: 7, permission: 'view reports' }],
          },
        ],
      }));

    const clientQueries = [];

    const clientQuery = jest.fn(async (sql, params) => {
      clientQueries.push({ sql, params });
      if (sql.trim().toUpperCase() === 'BEGIN') return { rows: [] };
      if (sql.includes('INSERT INTO in_kind_tracker.role')) {
        return { rows: [{ role_id: 42 }] };
      }
      if (sql.includes('INSERT INTO in_kind_tracker.role_permission')) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.trim().toUpperCase() === 'COMMIT') return { rows: [] };
      throw new Error(`Unexpected SQL during create: ${sql}`);
    });

    const release = jest.fn();
    pool.connect.mockResolvedValue({ query: clientQuery, release });

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/role',
      body: { role_name: 'QA', permission_ids: [7], default_route: null },
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      role_id: 42,
      role_name: 'QA',
      default_route: null,
      permissions: [{ permission_id: 7, permission: 'view reports' }],
    });

    expect(clientQuery).toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
    expect(clientQueries.map(({ sql }) => sql.trim().toUpperCase())).toEqual(
      expect.arrayContaining(['BEGIN', 'COMMIT']),
    );
  });

  test('POST /role rejects creation without permissions', async () => {
    pool.query.mockImplementationOnce(async () => ({ rows: [] }));

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/role',
      body: { role_name: 'QA' },
    });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  test('PATCH /role returns 404 when role does not exist', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [],
      }));

    const clientQuery = jest.fn(async (sql) => {
      const normalized = sql.trim().toUpperCase();
      if (normalized === 'BEGIN' || normalized === 'COMMIT') {
        return { rows: [] };
      }
      if (sql.includes('UPDATE in_kind_tracker.role SET role_name')) {
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`Unexpected SQL during update: ${sql}`);
    });

    pool.connect.mockResolvedValue({
      query: clientQuery,
      release: jest.fn(),
    });

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'PATCH',
      path: '/role/999',
      body: { role_name: 'Ghost' },
    });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Role not found' });
  });

  test('POST /role surfaces duplicate name conflicts', async () => {
    pool.query.mockImplementationOnce(async () => ({
      rows: [{ permission: 'manage users' }],
    }));

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const clientQuery = jest.fn(async (sql) => {
      const normalized = sql.trim().toUpperCase();
      if (normalized === 'BEGIN') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO in_kind_tracker.role')) {
        const duplicateError = new Error('duplicate key value violates unique constraint');
        duplicateError.code = '23505';
        throw duplicateError;
      }
      if (normalized === 'ROLLBACK') {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL during conflict scenario: ${sql}`);
    });

    const release = jest.fn();
    pool.connect.mockResolvedValue({ query: clientQuery, release });

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/role',
      body: { role_name: 'Duplicate Role' },
    });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'A role with that name already exists.' });
    expect(errorSpy).toHaveBeenCalled();
    expect(clientQuery.mock.calls.map(([sql]) => sql.trim().toUpperCase())).toEqual(
      expect.arrayContaining(['BEGIN', 'ROLLBACK']),
    );
    expect(release).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test('POST /role prevents SQL injection in role_name', async () => {
    const injection = `admin'); DROP TABLE in_kind_tracker.role; --`;

    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage users' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [
          {
            role_id: 51,
            role_name: injection,
            default_route: null,
            permissions: [],
          },
        ],
      }));

    const clientQueries = [];
    const clientQuery = jest.fn(async (sql, params) => {
      clientQueries.push({ sql, params });
      const normalized = sql.trim().toUpperCase();
      if (normalized === 'BEGIN' || normalized === 'COMMIT') {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO in_kind_tracker.role')) {
        expect(sql).not.toContain(injection);
        expect(params).toEqual([injection, null]);
        return { rows: [{ role_id: 51 }] };
      }
      if (sql.includes('INSERT INTO in_kind_tracker.role_permission')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL during injection test: ${sql}`);
    });
    const release = jest.fn();
    pool.connect.mockResolvedValue({ query: clientQuery, release });

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/role',
      body: { role_name: injection },
    });

    expect(res.status).toBe(201);
    const insertCall = clientQueries.find(({ sql }) => sql.includes('INSERT INTO in_kind_tracker.role'));
    expect(insertCall).toBeTruthy();
    expect(insertCall.sql).not.toContain(injection);
    expect(insertCall.params[0]).toBe(injection);
    expect(release).toHaveBeenCalled();
  });
});
