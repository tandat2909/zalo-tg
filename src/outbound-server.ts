import http from 'http';
import { config } from './config.js';
import { sendOutboundZaloMessage, type OutboundZaloMessageRequest } from './zalo/outbound.js';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        req.destroy(new Error('Request body too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!config.outbound.internalToken) return true;
  return req.headers.authorization === `Bearer ${config.outbound.internalToken}`;
}

export function startOutboundServer(): http.Server | null {
  if (!config.outbound.enabled) return null;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/internal/health') {
        sendJSON(res, 200, { ok: true, outbound_enabled: true });
        return;
      }

      if (req.method !== 'POST' || url.pathname !== '/internal/outbound/zalo/messages') {
        sendJSON(res, 404, { ok: false, error: 'not found' });
        return;
      }

      if (!isAuthorized(req)) {
        sendJSON(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      const body = await readBody(req);
      const input = JSON.parse(body) as OutboundZaloMessageRequest;
      if (!input.request_id) {
        input.request_id = String(req.headers['idempotency-key'] ?? '');
      }

      const result = await sendOutboundZaloMessage(input);
      sendJSON(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message.includes('Missing') || message.includes('Unsupported') ? 400 : 500;
      sendJSON(res, status, { ok: false, error: message });
    }
  });

  server.listen(config.outbound.port, config.outbound.host, () => {
    console.log(`[Outbound] HTTP server listening on ${config.outbound.host}:${config.outbound.port}`);
  });

  return server;
}
