/**
 * Peers Routes
 *
 * Exposes cross-workspace peer discovery and messaging to the dashboard.
 */

import { Hono } from 'hono';
import type { Services } from '../services.js';

export function createPeersRoutes(services: Services) {
  const app = new Hono();

  // List all registered peers
  app.get('/api/peers', async (c) => {
    if (!services.peerBridge) {
      return c.json({ error: 'Cross-workspace messaging is not enabled' }, 503);
    }
    const peers = await services.peerBridge.listPeers();
    return c.json({
      peerId: services.peerBridge.getPeerId(),
      peers,
    });
  });

  // Send a message to another workspace
  app.post('/api/peers/send', async (c) => {
    if (!services.peerBridge) {
      return c.json({ error: 'Cross-workspace messaging is not enabled' }, 503);
    }
    const body = await c.req.json<{ to_id: string; message: string }>();
    if (!body.to_id || !body.message) {
      return c.json({ error: 'to_id and message are required' }, 400);
    }
    const ok = await services.peerBridge.sendMessage(body.to_id, body.message);
    return c.json({ ok });
  });

  return app;
}
