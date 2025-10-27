import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

router.use(express.json());

router.get('/', async (_req, res) => {
  try {
    const sql = `
      SELECT permission_id, permission
      FROM in_kind_tracker.permission
      ORDER BY permission ASC
    `;
    const { rows } = await pool.query(sql);
    return res.json(rows);
  } catch (err) {
    console.error('Error listing permissions:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

export { router };
