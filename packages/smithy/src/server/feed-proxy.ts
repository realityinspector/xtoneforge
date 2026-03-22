/**
 * Feed API Proxy Middleware
 *
 * Proxies /feed-api/* requests to the feed server running on a separate port.
 * This allows the smithy server to serve the feed client at root while
 * forwarding feed-specific API calls to the feed backend.
 */

import { Hono } from 'hono';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('feed-proxy');

const DEFAULT_FEED_PORT = 8080;

/**
 * Create feed API proxy routes.
 * Proxies /feed-api/* → http://localhost:{feedPort}/api/*
 * Also proxies /screenshots/* → http://localhost:{feedPort}/screenshots/*
 */
export function createFeedProxyRoutes(feedPort?: number): Hono {
  const app = new Hono();
  const port = feedPort ?? parseInt(process.env.FEED_PORT || String(DEFAULT_FEED_PORT), 10);
  const feedBase = `http://localhost:${port}`;

  logger.info(`Feed API proxy configured: /feed-api/* → ${feedBase}/api/*`);

  // Proxy all /feed-api/* requests to the feed server's /api/*
  app.all('/feed-api/*', async (c) => {
    const url = new URL(c.req.url);
    // Rewrite /feed-api/... to /api/...
    const targetPath = url.pathname.replace(/^\/feed-api/, '/api');
    const targetUrl = `${feedBase}${targetPath}${url.search}`;

    try {
      const headers = new Headers();
      // Forward relevant headers
      for (const [key, value] of Object.entries(c.req.header())) {
        if (key.toLowerCase() !== 'host' && value) {
          headers.set(key, value);
        }
      }

      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers,
        body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.raw.text(),
      });

      // Forward response headers
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        // Skip hop-by-hop headers
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      });

      const body = await response.arrayBuffer();
      return c.body(body, response.status as 200, responseHeaders);
    } catch (error) {
      logger.warn(`Feed proxy error for ${targetUrl}:`, error instanceof Error ? error.message : String(error));
      return c.json({ error: 'Feed server unavailable' }, 502);
    }
  });

  // Proxy /screenshots/* to the feed server
  app.get('/screenshots/*', async (c) => {
    const url = new URL(c.req.url);
    const targetUrl = `${feedBase}${url.pathname}${url.search}`;

    try {
      const response = await fetch(targetUrl);
      if (!response.ok) {
        return c.notFound();
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          responseHeaders[key] = value;
        }
      });

      const body = await response.arrayBuffer();
      return c.body(body, 200, responseHeaders);
    } catch {
      return c.notFound();
    }
  });

  return app;
}
