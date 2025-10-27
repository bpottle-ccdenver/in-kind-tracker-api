import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ error: 'username query parameter is required' });
    }

    const sql = `
      SELECT DISTINCT p.permission
      FROM in_kind_tracker.user_account ua
      JOIN in_kind_tracker.role r ON r.role_id = ua.role_id
      JOIN in_kind_tracker.role_permission rp ON rp.role_id = r.role_id
      JOIN in_kind_tracker.permission p ON p.permission_id = rp.permission_id
      WHERE ua.username = $1
      ORDER BY p.permission ASC
    `;
    const { rows } = await pool.query(sql, [username.trim().toLowerCase()]);

    const permissions = rows.map((row) => row.permission);
    return res.json({ username: username.trim().toLowerCase(), permissions });
  } catch (err) {
    console.error('Error fetching allowed permissions:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

export { router };
