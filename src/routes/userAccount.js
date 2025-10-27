import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

router.use(express.json());

const ALLOWED_STATUS = new Set(['pending', 'active', 'inactive']);

function normalizeUserRow(row) {
  if (!row) return row;
  const { user_id, role_id, role_name, default_route, ...rest } = row;
  return {
    user_id,
    role_id,
    role_name: role_name ?? null,
    role: role_name ?? null,
    app_role: role_name ?? null,
    default_route: default_route ?? null,
    ...rest,
  };
}

function validateStatus(status) {
  if (status === undefined || status === null) {
    return null;
  }
  const trimmed = String(status).trim().toLowerCase();
  if (!ALLOWED_STATUS.has(trimmed)) {
    throw new Error(`status must be one of: ${Array.from(ALLOWED_STATUS).join(', ')}`);
  }
  return trimmed;
}

async function ensureTherapistExists(therapistId) {
  if (therapistId === undefined || therapistId === null || therapistId === '') {
    return null;
  }
  if (typeof therapistId === 'string' && therapistId.toLowerCase() === 'none') {
    return null;
  }
  const parsed = Number(therapistId);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('therapist_id must be a positive integer');
  }
  const { rowCount } = await pool.query(
    'SELECT 1 FROM in_kind_tracker.therapist WHERE therapist_id = $1 LIMIT 1',
    [parsed],
  );
  if (rowCount === 0) {
    throw new Error('Referenced therapist does not exist');
  }
  return parsed;
}

async function ensureRoleExists(roleId) {
  if (roleId === undefined || roleId === null || roleId === '') {
    return null;
  }
  if (typeof roleId === 'string' && roleId.toLowerCase() === 'none') {
    return null;
  }
  const parsed = Number(roleId);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error('role_id must be a positive integer');
  }
  const { rowCount } = await pool.query(
    'SELECT 1 FROM in_kind_tracker.role WHERE role_id = $1 LIMIT 1',
    [parsed],
  );
  if (rowCount === 0) {
    throw new Error('Referenced role does not exist');
  }
  return parsed;
}

async function fetchUserById(userId, client = pool) {
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

function validateEmail(username) {
  if (!username) {
    throw new Error('username (email) is required');
  }
  const trimmed = String(username).trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmed)) {
    throw new Error('username must be a valid email address');
  }
  return trimmed;
}

router.get('/', async (_req, res) => {
  try {
    const sql = `
      SELECT ua.*, r.role_name, r.default_route
      FROM in_kind_tracker.user_account ua
      LEFT JOIN in_kind_tracker.role r ON r.role_id = ua.role_id
      ORDER BY created_at DESC, user_id DESC
    `;
    const { rows } = await pool.query(sql);
    return res.json(rows.map(normalizeUserRow));
  } catch (err) {
    console.error('Error listing users:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.get('/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const user = await fetchUserById(Number(user_id));
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json(user);
  } catch (err) {
    console.error('Error fetching user:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      username,
      name,
      status,
      profile_image_url,
      therapist_id,
      role_id,
    } = req.body || {};

    const validatedUsername = validateEmail(username);
    const validatedStatus = validateStatus(status) ?? 'pending';
    const validatedTherapistId = await ensureTherapistExists(therapist_id);
    const validatedRoleId = await ensureRoleExists(role_id);

    const sql = `
      INSERT INTO in_kind_tracker.user_account
        (username, name, status, profile_image_url, therapist_id, role_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `;
    const params = [
      validatedUsername,
      name ?? null,
      validatedStatus,
      profile_image_url ?? null,
      validatedTherapistId ?? null,
      validatedRoleId ?? null,
    ];

    const { rows } = await pool.query(sql, params);
    const created = await fetchUserById(rows[0].user_id);
    return res.status(201).json(created ?? normalizeUserRow(rows[0]));
  } catch (err) {
    console.error('Error creating user:', err);
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'A user with that username already exists.' });
    }
    if (err?.message) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.patch('/:user_id', async (req, res) => {
  try {
    const { user_id } = req.params;
    const payload = req.body || {};
    const entries = Object.entries(payload);
    if (entries.length === 0) {
      return res.status(400).json({ error: 'No fields provided for update' });
    }

    const setClauses = [];
    const values = [];

    for (const [key, value] of entries) {
      switch (key) {
        case 'username': {
          const validated = validateEmail(value);
          values.push(validated);
          setClauses.push(`username = $${values.length}`);
          break;
        }
        case 'name':
        case 'profile_image_url':
          values.push(value ?? null);
          setClauses.push(`${key} = $${values.length}`);
          break;
        case 'status': {
          const validated = validateStatus(value);
          values.push(validated);
          setClauses.push(`status = $${values.length}`);
          break;
        }
        case 'therapist_id': {
          const validated = await ensureTherapistExists(value);
          values.push(validated ?? null);
          setClauses.push(`therapist_id = $${values.length}`);
          break;
        }
        case 'role_id': {
          const validated = await ensureRoleExists(value);
          values.push(validated ?? null);
          setClauses.push(`role_id = $${values.length}`);
          break;
        }
        case 'last_login_at':
          throw new Error('last_login_at is managed by the system and cannot be updated manually');
        default:
          break;
      }
    }

    if (setClauses.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const sql = `
      UPDATE in_kind_tracker.user_account
      SET ${setClauses.join(', ')}
      WHERE user_id = $${values.length + 1}
      RETURNING *
    `;
    values.push(Number(user_id));

    const { rows } = await pool.query(sql, values);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const updated = await fetchUserById(rows[0].user_id);
    return res.json(updated ?? normalizeUserRow(rows[0]));
  } catch (err) {
    console.error('Error updating user:', err);
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'A user with that username already exists.' });
    }
    if (err?.message) {
      return res.status(400).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

export { router, normalizeUserRow, validateEmail };
