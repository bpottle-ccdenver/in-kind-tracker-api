import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

export function resetPoolMocks(pool) {
  pool.query.mockImplementation(() => {
    throw new Error('Unexpected pool.query invocation');
  });
  pool.connect.mockImplementation(() => {
    throw new Error('Unexpected pool.connect invocation');
  });
}

export function createMockRequest({ method, path, body, headers = {} }) {
  const normalizedHeaders = Object.entries(headers).reduce((acc, [key, value]) => {
    acc[String(key).toLowerCase()] = value;
    return acc;
  }, {});

  if (body !== undefined && body !== null && !normalizedHeaders['content-type']) {
    normalizedHeaders['content-type'] = 'application/json';
  }

  const req = new Readable({
    read() {
      this.push(null);
    },
  });

  req.method = method;
  req.url = path;
  req.originalUrl = path;
  req.headers = normalizedHeaders;
  req.get = (name) => req.headers[String(name).toLowerCase()];

  if (body !== undefined && body !== null) {
    req.body = typeof body === 'string' ? JSON.parse(body) : body;
    req._body = true;
  }

  return req;
}

export function createMockResponse() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.cookies = {};

  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.set = res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value;
    return res;
  };

  res.get = (key) => res.headers[String(key).toLowerCase()];

  res.json = (payload) => {
    res.set('content-type', 'application/json');
    res.body = payload;
    res.emit('finish');
    return res;
  };

  res.send = (payload) => {
    res.body = payload;
    res.emit('finish');
    return res;
  };

  res.end = (payload) => {
    if (payload !== undefined) {
      res.body = payload;
    }
    res.emit('finish');
    return res;
  };

  res.cookie = (name, value, options) => {
    res.cookies[name] = { value, options };
    return res;
  };

  res.clearCookie = (name, options) => {
    res.cookies[name] = { cleared: true, options };
    return res;
  };

  return res;
}

export function performRequest(app, { method, path, body, headers }) {
  const req = createMockRequest({ method, path, body, headers });
  const res = createMockResponse();
  return new Promise((resolve, reject) => {
    res.once('finish', () => resolve({ status: res.statusCode, body: res.body, headers: res.headers, cookies: res.cookies }));
    res.once('error', reject);
    app.handle(req, res, (err) => {
      if (err) {
        reject(err);
      }
    });
  });
}
