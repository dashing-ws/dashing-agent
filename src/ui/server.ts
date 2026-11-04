import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { StateStore, NodeState } from '../state.js';
import { PAGE } from './page.js';

export interface UiActions {
  pause: (loop: string) => void;
  resume: (loop: string) => void;
  preflight: () => Promise<void>;
  /** Runs the fix of a failed check; returns the reason when it cannot. */
  fix: (checkId: string, values: Record<string, string>) => string | undefined;
  cancelFix: () => void;
  /** Builds a new organization from the form; returns the reason when it cannot start. */
  build: (input: Record<string, unknown>) => string | undefined;
  /** Points this node at an organization folder that exists; returns the reason when it cannot. */
  useFolder: (folder: string) => Promise<string | undefined>;
  /** Sends a chat message to the front desk; returns the reason when it cannot. */
  chat: (text: string) => string | undefined;
  /** The absolute path of an organization file the page may show (an agent's avatar), or nothing. */
  orgFile: (rel: string) => string | undefined;
  /** The absolute path of a library file the page may show (a library agent's avatar), or nothing. */
  libraryFile: (rel: string) => string | undefined;
}

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp' };

export interface UiHandle {
  url: string;
  close: () => void;
}

/** Every POST must carry this header. A browser sends it only from this page, never cross-site. */
const GUARD_HEADER = 'x-dashing';

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      if (body.length < 64 * 1024) body += c;
    });
    req.on('end', () => {
      try {
        const v: unknown = body ? JSON.parse(body) : {};
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/** One page on localhost: the state of this node, streamed as it changes. */
export function startUi(state: StateStore, port: number, actions: UiActions): Promise<UiHandle> {
  const clients = new Set<http.ServerResponse>();
  const send = (s: NodeState): void => {
    const data = `data: ${JSON.stringify(s)}\n\n`;
    for (const c of clients) c.write(data);
  };
  let pending: NodeJS.Timeout | null = null;
  state.on('change', (s: NodeState) => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      send(s);
    }, 100);
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.state));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === 'GET' && (url.pathname.startsWith('/org/') || url.pathname.startsWith('/library/'))) {
      const abs = url.pathname.startsWith('/org/') ? actions.orgFile(decodeURIComponent(url.pathname.slice(5))) : actions.libraryFile(decodeURIComponent(url.pathname.slice(9)));
      const type = abs ? IMAGE_TYPES[path.extname(abs).toLowerCase()] : undefined;
      if (!abs || !type) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      fs.createReadStream(abs).on('error', () => res.end()).pipe(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify(state.state)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'POST') {
      if (!req.headers[GUARD_HEADER]) {
        res.writeHead(403);
        res.end('missing header');
        return;
      }
      const m = /^\/api\/loops\/([a-z]+)\/(pause|resume)$/.exec(url.pathname);
      if (m) {
        (m[2] === 'pause' ? actions.pause : actions.resume)(m[1]!);
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === '/api/preflight') {
        void actions.preflight();
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === '/api/folder') {
        const body = await readJson(req);
        const error = await actions.useFolder(typeof body.folder === 'string' ? body.folder.trim() : '').catch((e: Error) => e.message.split('\n')[0]);
        res.writeHead(error ? 409 : 202, { 'content-type': 'application/json' });
        res.end(JSON.stringify(error ? { error } : { ok: true }));
        return;
      }
      if (url.pathname === '/api/chat') {
        const body = await readJson(req);
        const error = actions.chat(typeof body.text === 'string' ? body.text : '');
        res.writeHead(error ? 409 : 202, { 'content-type': 'application/json' });
        res.end(JSON.stringify(error ? { error } : { ok: true }));
        return;
      }
      if (url.pathname === '/api/org/create') {
        const body = await readJson(req);
        let error: string | undefined;
        try {
          error = actions.build(body);
        } catch (e) {
          error = (e as Error).message;
        }
        res.writeHead(error ? 409 : 202, { 'content-type': 'application/json' });
        res.end(JSON.stringify(error ? { error } : { ok: true }));
        return;
      }
      if (url.pathname === '/api/fix/cancel') {
        actions.cancelFix();
        res.writeHead(204);
        res.end();
        return;
      }
      const f = /^\/api\/fix\/([a-z0-9-]+)$/.exec(url.pathname);
      if (f) {
        const body = await readJson(req);
        const raw = body.values && typeof body.values === 'object' ? (body.values as Record<string, unknown>) : {};
        const values: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') values[k] = v;
        let error: string | undefined;
        try {
          error = actions.fix(f[1]!, values);
        } catch (e) {
          error = (e as Error).message;
        }
        res.writeHead(error ? 409 : 202, { 'content-type': 'application/json' });
        res.end(JSON.stringify(error ? { error } : { ok: true }));
        return;
      }
    }
    res.writeHead(404);
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `http://localhost:${p}`,
        close: () => {
          for (const c of clients) c.end();
          server.close();
        },
      });
    });
  });
}
