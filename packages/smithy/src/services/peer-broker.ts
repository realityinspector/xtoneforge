/**
 * Peer Broker Service
 *
 * Standalone HTTP broker for cross-workspace peer discovery and messaging.
 * Adapted from claude-peers-mcp (https://github.com/louislva/claude-peers-mcp).
 *
 * Runs on localhost:7899 (configurable). One broker per machine.
 * Workspaces register as peers and exchange messages through it.
 *
 * @module
 */

import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';

// ============================================================================
// Types
// ============================================================================

export interface PeerInfo {
  id: string;
  name: string;
  pid: number;
  port: number;
  cwd: string;
  git_root: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
}

export interface PeerMessage {
  id: number;
  from_id: string;
  to_id: string;
  text: string;
  sent_at: string;
}

interface RegisterRequest {
  name: string;
  pid: number;
  port: number;
  cwd: string;
  git_root?: string | null;
  summary?: string;
}

interface RegisterResponse {
  id: string;
}

interface ListPeersRequest {
  scope?: 'machine' | 'directory' | 'repo';
  cwd?: string;
  git_root?: string | null;
  exclude_id?: string;
}

interface SendMessageRequest {
  from_id: string;
  to_id: string;
  text: string;
}

interface PollMessagesRequest {
  id: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_PORT = 7899;
const DEFAULT_DB_DIR = path.join(os.homedir(), '.config', 'stoneforge-boss');
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'peers.db');
const STALE_CLEANUP_INTERVAL_MS = 30_000;
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const ID_LENGTH = 8;

// ============================================================================
// Helpers
// ============================================================================

function generateId(): string {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  }
  return id;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res: http.ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ============================================================================
// Broker
// ============================================================================

export interface PeerBrokerOptions {
  port?: number;
  dbPath?: string;
}

export interface PeerBrokerHandle {
  stop(): void;
  port: number;
}

export function startPeerBroker(options: PeerBrokerOptions = {}): Promise<PeerBrokerHandle> {
  const port = options.port ?? DEFAULT_PORT;
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;

  // Ensure DB directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db: DatabaseType = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 3000');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS peers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pid INTEGER NOT NULL,
      port INTEGER NOT NULL DEFAULT 0,
      cwd TEXT NOT NULL,
      git_root TEXT,
      summary TEXT DEFAULT '',
      registered_at TEXT NOT NULL,
      last_seen TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      delivered INTEGER DEFAULT 0
    )
  `);

  // Prepared statements
  const stmts = {
    insertPeer: db.prepare(
      'INSERT INTO peers (id, name, pid, port, cwd, git_root, summary, registered_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ),
    deletePeerByPid: db.prepare('DELETE FROM peers WHERE pid = ?'),
    deletePeer: db.prepare('DELETE FROM peers WHERE id = ?'),
    updateLastSeen: db.prepare('UPDATE peers SET last_seen = ? WHERE id = ?'),
    updateSummary: db.prepare('UPDATE peers SET summary = ? WHERE id = ?'),
    getPeer: db.prepare('SELECT * FROM peers WHERE id = ?'),
    getAllPeers: db.prepare('SELECT * FROM peers'),
    getPeersByCwd: db.prepare('SELECT * FROM peers WHERE cwd = ?'),
    getPeersByGitRoot: db.prepare('SELECT * FROM peers WHERE git_root = ?'),
    insertMessage: db.prepare(
      'INSERT INTO messages (from_id, to_id, text, sent_at, delivered) VALUES (?, ?, ?, ?, 0)'
    ),
    pollMessages: db.prepare(
      'SELECT id, from_id, to_id, text, sent_at FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY id'
    ),
    markDelivered: db.prepare('UPDATE messages SET delivered = 1 WHERE to_id = ? AND delivered = 0'),
    deleteMessagesForPeer: db.prepare('DELETE FROM messages WHERE from_id = ? OR to_id = ?'),
  };

  // Stale peer cleanup
  function cleanStalePeers(): void {
    const peers = stmts.getAllPeers.all() as PeerInfo[];
    for (const peer of peers) {
      if (!isPidAlive(peer.pid)) {
        stmts.deletePeer.run(peer.id);
        stmts.deleteMessagesForPeer.run(peer.id, peer.id);
      }
    }
  }

  // Run cleanup on start and every 30s
  cleanStalePeers();
  const cleanupInterval = setInterval(cleanStalePeers, STALE_CLEANUP_INTERVAL_MS);

  // Request handlers
  function handleRegister(body: RegisterRequest): RegisterResponse {
    const now = new Date().toISOString();
    // Remove existing registration for this PID
    stmts.deletePeerByPid.run(body.pid);
    const id = generateId();
    stmts.insertPeer.run(
      id,
      body.name,
      body.pid,
      body.port ?? 0,
      body.cwd,
      body.git_root ?? null,
      body.summary ?? '',
      now,
      now
    );
    return { id };
  }

  function handleHeartbeat(body: { id: string }): { ok: boolean } {
    stmts.updateLastSeen.run(new Date().toISOString(), body.id);
    return { ok: true };
  }

  function handleSetSummary(body: { id: string; summary: string }): { ok: boolean } {
    stmts.updateSummary.run(body.summary, body.id);
    return { ok: true };
  }

  function handleListPeers(body: ListPeersRequest): PeerInfo[] {
    let peers: PeerInfo[];
    const scope = body.scope ?? 'machine';

    if (scope === 'directory' && body.cwd) {
      peers = stmts.getPeersByCwd.all(body.cwd) as PeerInfo[];
    } else if (scope === 'repo' && body.git_root) {
      peers = stmts.getPeersByGitRoot.all(body.git_root) as PeerInfo[];
    } else {
      peers = stmts.getAllPeers.all() as PeerInfo[];
    }

    // Filter out dead PIDs and excluded ID
    return peers.filter(p => {
      if (body.exclude_id && p.id === body.exclude_id) return false;
      if (!isPidAlive(p.pid)) {
        stmts.deletePeer.run(p.id);
        return false;
      }
      return true;
    });
  }

  function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
    const target = stmts.getPeer.get(body.to_id) as PeerInfo | undefined;
    if (!target) {
      return { ok: false, error: `Peer ${body.to_id} not found` };
    }
    stmts.insertMessage.run(body.from_id, body.to_id, body.text, new Date().toISOString());
    return { ok: true };
  }

  function handlePollMessages(body: PollMessagesRequest): { messages: PeerMessage[] } {
    const messages = stmts.pollMessages.all(body.id) as PeerMessage[];
    if (messages.length > 0) {
      stmts.markDelivered.run(body.id);
    }
    return { messages };
  }

  function handleUnregister(body: { id: string }): { ok: boolean } {
    stmts.deletePeer.run(body.id);
    stmts.deleteMessagesForPeer.run(body.id, body.id);
    return { ok: true };
  }

  // HTTP server
  const server = http.createServer(async (req, res) => {
    try {
      // Health check (GET)
      if (req.method === 'GET' && req.url === '/health') {
        const peers = stmts.getAllPeers.all() as PeerInfo[];
        return json(res, { status: 'ok', peers: peers.length });
      }

      // All other endpoints are POST
      if (req.method !== 'POST') {
        return json(res, { error: 'Method not allowed' }, 405);
      }

      const body = await parseBody(req) as Record<string, unknown>;

      switch (req.url) {
        case '/register':
          return json(res, handleRegister(body as unknown as RegisterRequest));
        case '/heartbeat':
          return json(res, handleHeartbeat(body as { id: string }));
        case '/set-summary':
          return json(res, handleSetSummary(body as { id: string; summary: string }));
        case '/list-peers':
          return json(res, handleListPeers(body as unknown as ListPeersRequest));
        case '/send-message':
          return json(res, handleSendMessage(body as unknown as SendMessageRequest));
        case '/poll-messages':
          return json(res, handlePollMessages(body as unknown as PollMessagesRequest));
        case '/unregister':
          return json(res, handleUnregister(body as { id: string }));
        default:
          return json(res, { error: 'Not found' }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json(res, { error: message }, 500);
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        stop() {
          clearInterval(cleanupInterval);
          server.close();
          db.close();
        },
      });
    });
  });
}

// ============================================================================
// Standalone entry point
// ============================================================================

const isMainModule = process.argv[1] &&
  (process.argv[1].endsWith('peer-broker.js') || process.argv[1].endsWith('peer-broker.ts'));

if (isMainModule) {
  const port = parseInt(process.env.STONEFORGE_PEERS_PORT ?? String(DEFAULT_PORT), 10);
  const dbPath = process.env.STONEFORGE_PEERS_DB ?? DEFAULT_DB_PATH;

  startPeerBroker({ port, dbPath }).then((handle) => {
    console.log(`Peer broker listening on 127.0.0.1:${handle.port}`);
    console.log(`Database: ${dbPath}`);

    process.on('SIGINT', () => {
      handle.stop();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      handle.stop();
      process.exit(0);
    });
  }).catch((err) => {
    console.error('Failed to start peer broker:', err);
    process.exit(1);
  });
}
