// src/server.js
import dotenv from 'dotenv';
import express from 'express';
import { router as locationRoute } from './routes/location.js';
import { router as permissionRoute } from './routes/permission.js';
import { router as roleRoute } from './routes/role.js';
import { router as allowedPermissionsRoute } from './routes/allowedPermissions.js';
import { router as authRoute, extractSessionId, fetchUserBySession, clearSessionCookie } from './routes/auth.js';
import { router as userAccountRoute } from './routes/userAccount.js';
import { assertDbConnection, pool } from './db.js';
import { requirePermissions } from './middleware/authorization.js';

dotenv.config();

const app = express();

const AUTH_EXEMPT_PATHS = new Set(['/auth/login', '/auth/logout', '/auth/users', '/health']);

function isAuthExemptPath(pathname) {
  if (!pathname) return false;
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (AUTH_EXEMPT_PATHS.has(normalized)) {
    return true;
  }
  for (const exempt of AUTH_EXEMPT_PATHS) {
    if (
      normalized.length > exempt.length &&
      normalized.endsWith(exempt) &&
      normalized.charAt(normalized.length - exempt.length - 1) === '/'
    ) {
      return true;
    }
  }
  return false;
}

// Minimal CORS for dev with credential support
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Credentials', 'true');
  } else {
    res.set('Access-Control-Allow-Origin', '*');
  }
  res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

const updateSessionActivity = async (sessionId) => {
  try {
    await pool.query('UPDATE in_kind_tracker.user_session SET last_seen_at = NOW() WHERE session_id = $1', [sessionId]);
  } catch (err) {
    console.error('Failed to update session activity:', err?.message || err);
  }
};

app.use(async (req, res, next) => {
  try {
    if (req.method === 'OPTIONS' || isAuthExemptPath(req.path)) {
      return next();
    }

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

    req.sessionId = sessionId;
    req.user = user;
    updateSessionActivity(sessionId);
    return next();
  } catch (err) {
    console.error('Error authenticating request:', err);
    return res.status(500).json({ error: 'Internal server error, ' + (err?.message || err) });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

// Mount routes
app.use('/auth', authRoute);

const guardedRoutes = [
  ['/location', locationRoute, { read: 'view locations', manage: 'manage locations' }],
  ['/permission', permissionRoute, { read: 'manage users', manage: 'manage users' }],
  ['/role', roleRoute, { read: 'manage users', manage: 'manage users' }],
  ['/allowed-permissions', allowedPermissionsRoute, { read: 'manage users', manage: 'manage users' }],
  ['/user', userAccountRoute, { read: 'view users', manage: 'manage users' }],
];

guardedRoutes.forEach(([path, router, permissions]) => {
  app.use(path, requirePermissions(permissions), router);
});

// Start after confirming DB connectivity
const port = process.env.PORT || 3001;
console.log('[Server] Starting Practice Pulse API');
console.log('[Server] PORT =', port);
console.log('[Server] NODE_ENV =', process.env.NODE_ENV || 'development');

assertDbConnection()
  .then(() => {
    app
      .listen(port, () => {
        console.log(`API listening on http://localhost:${port}`);
      })
      .on('error', (err) => {
        console.error('[Server] HTTP server error:', err);
        process.exit(1);
      });
  })
  .catch((err) => {
    console.error('Failed to start server due to DB error:', err?.message || err);
    process.exit(1);
  });

// Graceful shutdown (Ctrl+C)
process.on('SIGINT', async () => {
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
});
