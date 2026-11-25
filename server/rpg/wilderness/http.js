// GET /api/wilderness/scene?location=wilderness:<px>,<py> -> the public scene descriptor (JSON).
//
// Only composed descriptors leave the server: no mod file, path or archive is ever read through this route.
// Wire it in the HTTP server before the generic /api handler:
//   if (path === WILDERNESS_SCENE_PATH) return handleWildernessScene(runtime.ctx.services.wilderness, req, res);

import { parseWildernessId } from '../../../client/world/wilderness/data.js';

export const WILDERNESS_SCENE_PATH = '/api/wilderness/scene';

function json(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store',
    ...extra,
  });
  res.end(req(res) === 'HEAD' ? undefined : text);
}
const req = (res) => res.req?.method;

/**
 * @param {object} service ctx.services.wilderness
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} true when the request was handled
 */
export function handleWildernessScene(service, request, res) {
  const url = new URL(request.url, 'http://local');
  if (url.pathname !== WILDERNESS_SCENE_PATH) return false;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    json(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
    return true;
  }
  const location = url.searchParams.get('location') ?? '';
  if (!parseWildernessId(location)) {
    json(res, 400, { error: 'expected location=wilderness:<px>,<py>' });
    return true;
  }
  if (!service) {
    json(res, 503, { error: 'wilderness feature is not installed', pack: 'missing' });
    return true;
  }
  const st = service.status();
  if (st.pack !== 'ready') {
    json(res, 503, { error: st.note || 'World of Daggerfall data is not available', pack: st.pack });
    return true;
  }
  try {
    json(res, 200, service.scene(location));
  } catch {
    json(res, 500, { error: 'could not compose the scene' });
  }
  return true;
}
