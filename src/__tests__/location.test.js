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
import { router as locationRouter } from '../routes/location.js';
import { performRequest, resetPoolMocks } from './testUtils/requestUtils.js';

function createTestApp(user = { user_id: 830 }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  app.use(
    '/location',
    requirePermissions({ read: 'view locations', manage: 'manage locations' }),
    locationRouter,
  );
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  resetPoolMocks(pool);
});

describe('Location routes', () => {
  test('GET /location denies access without permission', async () => {
    pool.query.mockImplementationOnce(async () => ({ rows: [] }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/location' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  test('GET /location returns locations', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'view locations' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [
          { location_id: 1, name: 'Main Office' },
        ],
      }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/location' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ location_id: 1, name: 'Main Office' }]);
  });

  test('POST /location creates a location', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage locations' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [
          { location_id: 4, name: 'New Site', notes: null },
        ],
      }));

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/location',
      body: { name: 'New Site' },
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ location_id: 4, name: 'New Site', notes: null });
  });

  test('POST /location validates name', async () => {
    pool.query.mockImplementationOnce(async () => ({
      rows: [{ permission: 'manage locations' }],
    }));

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'POST',
      path: '/location',
      body: { name: '   ' },
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Location name is required' });
  });

  test('GET /location/:id returns 404 for missing location', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'view locations' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [],
      }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: '/location/15' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Location not found' });
  });

  test('PATCH /location requires fields', async () => {
    pool.query.mockImplementationOnce(async () => ({
      rows: [{ permission: 'manage locations' }],
    }));

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'PATCH',
      path: '/location/3',
      body: {},
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'No updatable fields provided' });
  });

  test('PATCH /location updates record', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage locations' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [
          { location_id: 3, name: 'Updated Location', notes: 'note' },
        ],
      }));

    const app = createTestApp();
    const res = await performRequest(app, {
      method: 'PATCH',
      path: '/location/3',
      body: { name: 'Updated Location', notes: 'note' },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ location_id: 3, name: 'Updated Location', notes: 'note' });
  });

  test('DELETE /location/:id returns 404 when missing', async () => {
    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'manage locations' }],
      }))
      .mockImplementationOnce(async () => ({
        rows: [],
      }));

    const app = createTestApp();
    const res = await performRequest(app, { method: 'DELETE', path: '/location/8' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Location not found' });
  });

  test('GET /location/:id resists SQL injection in path', async () => {
    const injection = `5; DROP TABLE in_kind_tracker.location; --`;

    pool.query
      .mockImplementationOnce(async () => ({
        rows: [{ permission: 'view locations' }],
      }))
      .mockImplementationOnce(async (sql, params) => {
        expect(sql).not.toContain(injection);
        expect(params).toEqual([injection]);
        return { rows: [] };
      });

    const app = createTestApp();
    const res = await performRequest(app, { method: 'GET', path: `/location/${encodeURIComponent(injection)}` });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Location not found' });
  });
});
