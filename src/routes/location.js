import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

router.use(express.json());

/**
 * GET /location
 * Returns all locations ordered by creation.
 */
router.get('/', async (_req, res) => {
  try {
    const sql = `
      SELECT *
      FROM in_kind_tracker.location
      ORDER BY location_id ASC
    `;
    const { rows } = await pool.query(sql);
    return res.json(rows);
  } catch (err) {
    console.error('Error listing locations:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

/**
 * POST /location
 * Creates a new location record.
 */
router.post('/', async (req, res) => {
  try {
    const { name, notes } = req.body || {};

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Location name is required' });
    }

    const sql = `
      INSERT INTO in_kind_tracker.location (name, notes)
      VALUES ($1, $2)
      RETURNING *
    `;
    const params = [name.trim(), notes ?? null];
    const { rows } = await pool.query(sql, params);
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Error creating location:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

/**
 * GET /location/:location_id
 * Returns a single location by id.
 */
router.get('/:location_id', async (req, res) => {
  try {
    const { location_id } = req.params;
    const sql = `
      SELECT *
      FROM in_kind_tracker.location
      WHERE location_id = $1
      LIMIT 1
    `;
    const { rows } = await pool.query(sql, [location_id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('Error fetching location:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

/**
 * PATCH /location/:location_id
 * Partially updates a location record.
 */
router.patch('/:location_id', async (req, res) => {
  try {
    const { location_id } = req.params;
    const updatableFields = ['name', 'notes'];
    const providedEntries = Object.entries(req.body || {}).filter(([key]) => updatableFields.includes(key));

    if (providedEntries.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    const setClauses = providedEntries.map(([key], idx) => `${key} = $${idx + 1}`);
    const values = providedEntries.map(([, value]) => value);
    values.push(location_id);

    const sql = `
      UPDATE in_kind_tracker.location
      SET ${setClauses.join(', ')}
      WHERE location_id = $${values.length}
      RETURNING *
    `;
    const { rows } = await pool.query(sql, values);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('Error updating location:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

/**
 * DELETE /location/:location_id
 * Deletes a location record.
 */
router.delete('/:location_id', async (req, res) => {
  try {
    const { location_id } = req.params;
    const sql = `
      DELETE FROM in_kind_tracker.location
      WHERE location_id = $1
      RETURNING location_id
    `;
    const { rows } = await pool.query(sql, [location_id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Location not found' });
    }
    return res.status(204).send();
  } catch (err) {
    console.error('Error deleting location:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

export { router };
