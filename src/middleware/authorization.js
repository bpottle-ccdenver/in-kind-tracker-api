import { pool } from '../db.js';

const READ_METHODS = new Set(['GET', 'HEAD']);
const USER_PERMISSION_CACHE_KEY = Symbol('userPermissions');

async function queryUserPermissions(userId) {
  const sql = `
    SELECT DISTINCT p.permission
    FROM in_kind_tracker.user_account ua
    LEFT JOIN in_kind_tracker.role_permission rp ON rp.role_id = ua.role_id
    LEFT JOIN in_kind_tracker.permission p ON p.permission_id = rp.permission_id
    WHERE ua.user_id = $1
      AND p.permission IS NOT NULL
  `;
  const { rows } = await pool.query(sql, [userId]);
  return rows.map((row) => row.permission.toLowerCase());
}

async function getUserPermissions(req) {
  if (!req || !req.user) {
    return new Set();
  }

  if (!req[USER_PERMISSION_CACHE_KEY]) {
    const permissions = await queryUserPermissions(req.user.user_id);
    req[USER_PERMISSION_CACHE_KEY] = new Set(permissions);
  }

  return req[USER_PERMISSION_CACHE_KEY];
}

function requirePermissions({ read, manage }) {
  const requiredRead = read ? read.toLowerCase() : null;
  const requiredManage = manage ? manage.toLowerCase() : null;

  return async (req, res, next) => {
    try {
      if (req.method === 'OPTIONS') {
        return next();
      }

      if (!req.user) {
        return res.status(401).json({ error: 'Not authenticated' });
      }

      const permissions = await getUserPermissions(req);
      const hasPermission = (permission) => permission && permissions.has(permission);

      if (READ_METHODS.has(req.method)) {
        if (hasPermission(requiredRead) || hasPermission(requiredManage)) {
          return next();
        }
        return res.status(403).json({ error: 'Forbidden' });
      }

      if (hasPermission(requiredManage)) {
        return next();
      }

      return res.status(403).json({ error: 'Forbidden' });
    } catch (err) {
      console.error('Error validating permissions:', err);
      return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
    }
  };
}

async function listUserPermissions(userId) {
  if (!userId) {
    return [];
  }
  const permissions = await queryUserPermissions(userId);
  return Array.from(new Set(permissions));
}

export { requirePermissions, getUserPermissions, listUserPermissions };
