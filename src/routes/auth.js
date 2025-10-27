import express from 'express';
import { randomUUID } from 'node:crypto';
import { pool } from '../db.js';
import { normalizeUserRow } from './userAccount.js';
import { listUserPermissions } from '../middleware/authorization.js';

const USER_STATUSES = new Set(['pending', 'active', 'inactive']);

const router = express.Router();

router.use(express.json());

const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'pp_session';
const SESSION_MAX_AGE_DAYS = Number(process.env.SESSION_MAX_AGE_DAYS || 7);
// TODO: revert secure cookies to align with production HTTPS once TLS is configured
const SESSION_COOKIE_SECURE = false;

const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: SESSION_COOKIE_SECURE,
  path: '/',
};

function setSessionCookie(res, sessionId) {
  res.cookie(SESSION_COOKIE_NAME, sessionId, {
    ...SESSION_COOKIE_OPTIONS,
    maxAge: SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS);
}

async function fetchUserForLogin(userId, client = pool) {
  const sql = `
    SELECT ua.*, r.role_name, r.default_route
    FROM in_kind_tracker.user_account ua
    LEFT JOIN in_kind_tracker.role r ON r.role_id = ua.role_id
    WHERE ua.user_id = $1
    LIMIT 1
  `;
  const { rows } = await client.query(sql, [userId]);
  return rows.length ? normalizeUserRow(rows[0]) : null;
}

async function fetchUserBySession(sessionId) {
  const sql = `
    SELECT s.session_id, ua.*, r.role_name, r.default_route
    FROM in_kind_tracker.user_session s
    JOIN in_kind_tracker.user_account ua ON ua.user_id = s.user_id
    LEFT JOIN in_kind_tracker.role r ON r.role_id = ua.role_id
    WHERE s.session_id = $1
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [sessionId]);
  if (rows.length === 0) {
    return null;
  }
  const { session_id, ...userRow } = rows[0];
  return normalizeUserRow(userRow);
}

function extractSessionId(req) {
  const cookieHeader = req.headers?.cookie;
  if (!cookieHeader) return null;
  const cookies = cookieHeader.split(';');
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.trim().split('=');
    if (key === SESSION_COOKIE_NAME) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return null;
}

router.post('/login', async (req, res) => {
  let client;
  try {
    const { user_id } = req.body || {};
    if (!user_id || !Number.isInteger(Number(user_id))) {
      return res.status(400).json({ error: 'user_id is required.' });
    }

    client = await pool.connect();
    await client.query('BEGIN');

    const user = await fetchUserForLogin(Number(user_id), client);
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const normalizedStatus = String(user.status ?? '').trim().toLowerCase();
    if (!USER_STATUSES.has(normalizedStatus) || normalizedStatus === 'inactive') {
      await client.query('ROLLBACK');
      const message = normalizedStatus === 'inactive'
        ? 'User account is inactive'
        : 'User status does not permit login';
      return res.status(403).json({ error: message });
    }

    const sessionId = randomUUID();

    await client.query(
      `
        UPDATE in_kind_tracker.user_account
        SET status = CASE WHEN status = 'pending' THEN 'active' ELSE status END,
            last_login_at = NOW()
        WHERE user_id = $1
      `,
      [user.user_id],
    );

    await client.query(
      `INSERT INTO in_kind_tracker.user_session (session_id, user_id) VALUES ($1, $2)`,
      [sessionId, user.user_id],
    );

    const loggedInUser = await fetchUserForLogin(user.user_id, client);

    await client.query('COMMIT');
    client.release();
    client = null;

    setSessionCookie(res, sessionId);

    const permissions = await listUserPermissions(user.user_id);
    return res.json({ ...(loggedInUser ?? user), permissions });
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('Error rolling back transaction during login:', rollbackErr);
      } finally {
        client.release();
        client = null;
      }
    }
    console.error('Error logging in:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  } finally {
    if (client) {
      client.release();
    }
  }
});

router.post('/logout', async (req, res) => {
  try {
    const sessionId = extractSessionId(req);
    if (sessionId) {
      await pool.query('DELETE FROM in_kind_tracker.user_session WHERE session_id = $1', [sessionId]);
    }
    clearSessionCookie(res);
    return res.status(204).send();
  } catch (err) {
    console.error('Error logging out:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.get('/users', async (req, res) => {
  try {
    const { status } = req.query || {};
    let requestedStatuses;

    if (status === undefined) {
      requestedStatuses = ['active'];
    } else if (Array.isArray(status)) {
      requestedStatuses = status;
    } else {
      requestedStatuses = String(status).split(',');
    }

    requestedStatuses = requestedStatuses
      .map((value) => String(value).trim().toLowerCase())
      .filter((value) => value.length > 0);

    if (requestedStatuses.length === 0) {
      requestedStatuses = ['active'];
    }

    const invalidStatuses = requestedStatuses.filter((value) => !USER_STATUSES.has(value));
    if (invalidStatuses.length > 0) {
      return res.status(400).json({ error: `Invalid status values: ${invalidStatuses.join(', ')}` });
    }

    const uniqueStatuses = Array.from(new Set(requestedStatuses));

    const sql = `
      SELECT ua.user_id, ua.username, ua.name, ua.status, r.role_name, r.default_route
      FROM in_kind_tracker.user_account ua
      LEFT JOIN in_kind_tracker.role r ON r.role_id = ua.role_id
      WHERE ua.status = ANY($1::text[])
      ORDER BY
        COALESCE(array_position($1::text[], ua.status), 2147483647),
        ua.name NULLS LAST,
        ua.username ASC
    `;
    const { rows } = await pool.query(sql, [uniqueStatuses]);
    const users = rows.map((row) => ({
      user_id: row.user_id,
      username: row.username,
      name: row.name,
      status: row.status,
      role_name: row.role_name,
      default_route: row.default_route,
    }));
    return res.json(users);
  } catch (err) {
    console.error('Error listing users for login:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.get('/me', async (req, res) => {
  try {
    const sessionId = extractSessionId(req);
    if (!sessionId) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = await fetchUserBySession(sessionId);
    if (!user) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const permissions = await listUserPermissions(user.user_id);
    return res.json({ ...user, permissions });
  } catch (err) {
    console.error('Error fetching current user:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

export { router, extractSessionId, fetchUserBySession, setSessionCookie, clearSessionCookie, SESSION_COOKIE_NAME };
