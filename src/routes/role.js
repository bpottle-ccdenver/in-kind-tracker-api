import express from 'express';
import { pool } from '../db.js';

const router = express.Router();

router.use(express.json());

function normalizeRoleRow(row) {
  if (!row) return row;
  const { role_id, role_name, default_route, permissions } = row;
  return {
    role_id,
    role_name,
    default_route: default_route ?? null,
    permissions: Array.isArray(permissions) ? permissions : [],
  };
}

async function fetchRoleById(roleId, client = pool) {
  const sql = `
    SELECT
      r.role_id,
      r.role_name,
      r.default_route,
      COALESCE(
        json_agg(
          json_build_object(
            'permission_id', p.permission_id,
            'permission', p.permission
          )
          ORDER BY p.permission
        ) FILTER (WHERE p.permission_id IS NOT NULL),
        '[]'::json
      ) AS permissions
    FROM in_kind_tracker.role r
    LEFT JOIN in_kind_tracker.role_permission rp ON rp.role_id = r.role_id
    LEFT JOIN in_kind_tracker.permission p ON p.permission_id = rp.permission_id
    WHERE r.role_id = $1
    GROUP BY r.role_id, r.role_name, r.default_route
    LIMIT 1
  `;
  const { rows } = await client.query(sql, [roleId]);
  return rows.length ? normalizeRoleRow(rows[0]) : null;
}

router.get('/', async (_req, res) => {
  try {
    const sql = `
      SELECT
        r.role_id,
        r.role_name,
        r.default_route,
        COALESCE(
          json_agg(
            json_build_object(
              'permission_id', p.permission_id,
              'permission', p.permission
            )
            ORDER BY p.permission
        ) FILTER (WHERE p.permission_id IS NOT NULL),
        '[]'::json
      ) AS permissions
      FROM in_kind_tracker.role r
      LEFT JOIN in_kind_tracker.role_permission rp ON rp.role_id = r.role_id
      LEFT JOIN in_kind_tracker.permission p ON p.permission_id = rp.permission_id
      GROUP BY r.role_id, r.role_name, r.default_route
      ORDER BY r.role_name ASC
    `;
    const { rows } = await pool.query(sql);
    return res.json(rows.map(normalizeRoleRow));
  } catch (err) {
    console.error('Error listing roles:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

router.post('/', async (req, res) => {
  const { role_name, permission_ids, default_route } = req.body || {};

  if (!role_name || !String(role_name).trim()) {
    return res.status(400).json({ error: 'role_name is required.' });
  }

  const trimmedDefaultRoute = default_route === undefined || default_route === null
    ? null
    : String(default_route).trim() || null;

  const permissionIds = Array.isArray(permission_ids)
    ? Array.from(new Set(permission_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)))
    : [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertSql = `
      INSERT INTO in_kind_tracker.role (role_name, default_route)
      VALUES ($1, $2)
      RETURNING role_id
    `;
    const { rows: insertRows } = await client.query(insertSql, [role_name.trim(), trimmedDefaultRoute]);
    const newRoleId = insertRows[0].role_id;

    if (permissionIds.length > 0) {
      const insertPermissionsSql = `
        INSERT INTO in_kind_tracker.role_permission (role_id, permission_id)
        SELECT $1, permission_id
        FROM in_kind_tracker.permission
        WHERE permission_id = ANY($2::int[])
      `;
      await client.query(insertPermissionsSql, [newRoleId, permissionIds]);
    }

    await client.query('COMMIT');

    const fresh = await fetchRoleById(newRoleId);
    return res.status(201).json(fresh);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error creating role:', err);
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'A role with that name already exists.' });
    }
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  } finally {
    client.release();
  }
});

router.patch('/:role_id', async (req, res) => {
  const { role_id } = req.params;
  const { role_name, permission_ids, default_route } = req.body || {};

  const hasRoleNameUpdate = role_name !== undefined;
  const hasPermissionsUpdate = Array.isArray(permission_ids);
  const hasDefaultRouteUpdate = default_route !== undefined;

  if (!hasRoleNameUpdate && !hasPermissionsUpdate && !hasDefaultRouteUpdate) {
    return res.status(400).json({ error: 'No updatable fields provided.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (hasRoleNameUpdate) {
      if (!role_name || !String(role_name).trim()) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'role_name cannot be empty.' });
      }
      await client.query(
        `UPDATE in_kind_tracker.role SET role_name = $1 WHERE role_id = $2`,
        [role_name.trim(), role_id],
      );
    }

    if (hasDefaultRouteUpdate) {
      const trimmedDefaultRoute = default_route === null || default_route === undefined
        ? null
        : String(default_route).trim() || null;
      await client.query(
        `UPDATE in_kind_tracker.role SET default_route = $1 WHERE role_id = $2`,
        [trimmedDefaultRoute, role_id],
      );
    }

    if (hasPermissionsUpdate) {
      const permissionIds = Array.from(
        new Set(permission_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)),
      );

      if (permissionIds.length === 0) {
        await client.query(
          `DELETE FROM in_kind_tracker.role_permission WHERE role_id = $1`,
          [role_id],
        );
      } else {
        await client.query(
          `
            DELETE FROM in_kind_tracker.role_permission
            WHERE role_id = $1
              AND permission_id NOT IN (SELECT unnest($2::int[]))
          `,
          [role_id, permissionIds],
        );

        await client.query(
          `
            INSERT INTO in_kind_tracker.role_permission (role_id, permission_id)
            SELECT $1, permission_id
            FROM in_kind_tracker.permission
            WHERE permission_id = ANY($2::int[])
              AND NOT EXISTS (
                SELECT 1
                FROM in_kind_tracker.role_permission rp
                WHERE rp.role_id = $1 AND rp.permission_id = in_kind_tracker.permission.permission_id
              )
          `,
          [role_id, permissionIds],
        );
      }
    }

    await client.query('COMMIT');
    const fresh = await fetchRoleById(role_id);
    if (!fresh) {
      return res.status(404).json({ error: 'Role not found' });
    }
    return res.json(fresh);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating role:', err);
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'A role with that name already exists.' });
    }
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  } finally {
    client.release();
  }
});

router.delete('/:role_id', async (req, res) => {
  try {
    const { role_id } = req.params;
    const sql = `
      DELETE FROM in_kind_tracker.role
      WHERE role_id = $1
        AND role_name <> 'admin'
      RETURNING role_id
    `;
    const { rows } = await pool.query(sql, [Number(role_id)]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Role not found or cannot be deleted' });
    }
    return res.status(204).send();
  } catch (err) {
    console.error('Error deleting role:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

export { router };
