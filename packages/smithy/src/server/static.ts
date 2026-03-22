/**
 * Static File Serving Middleware
 *
 * Serves pre-built web UI assets from webRoot directories.
 * Supports serving a primary app (feed) at root and the dashboard at /dashboard.
 * Falls back to index.html for client-side routing (SPA catch-all).
 * Reusable by both quarry and smithy servers.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import type { Hono } from 'hono';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('static');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
};

/**
 * Serve a static file from a directory. Returns a Response or null if not found.
 */
function serveFile(webRoot: string, relativePath: string, c: { body: (content: Buffer, status: number, headers: Record<string, string>) => Response }): Response | null {
  const filePath = resolve(webRoot, relativePath);

  // Prevent directory traversal
  if (!filePath.startsWith(webRoot)) {
    return null;
  }

  if (existsSync(filePath)) {
    const ext = extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = readFileSync(filePath);
    return c.body(content, 200, { 'Content-Type': contentType });
  }

  return null;
}

/**
 * Register static file serving middleware on a Hono app.
 * Only registers if the webRoot directory exists.
 *
 * API routes (/api/*) and WebSocket routes (/ws*) are NOT intercepted.
 * All other GET requests are served from the webRoot directory,
 * with SPA fallback to index.html for unmatched paths.
 */
export function registerStaticMiddleware(app: Hono, webRoot: string): void {
  if (!existsSync(webRoot)) {
    return;
  }

  const indexPath = resolve(webRoot, 'index.html');
  const hasIndex = existsSync(indexPath);

  logger.info(`Serving web assets from ${webRoot}`);

  app.get('*', (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Skip API, feed-api, and WebSocket routes
    if (path.startsWith('/api/') || path.startsWith('/feed-api/') || path.startsWith('/ws')) {
      return next();
    }

    // Skip dashboard routes - those are handled by registerDashboardMiddleware
    if (path.startsWith('/dashboard')) {
      return next();
    }

    // Try to serve the exact file
    const relativePath = path === '/' ? 'index.html' : path.slice(1);
    const response = serveFile(webRoot, relativePath, c);
    if (response) return response;

    // SPA fallback: serve index.html for non-file paths
    if (hasIndex && !extname(path)) {
      const content = readFileSync(indexPath);
      return c.body(content, 200, { 'Content-Type': 'text/html' });
    }

    return next();
  });
}

/**
 * Register dashboard static file serving at /dashboard prefix.
 * Serves the smithy-web build under the /dashboard path prefix.
 */
export function registerDashboardMiddleware(app: Hono, dashboardRoot: string): void {
  if (!existsSync(dashboardRoot)) {
    return;
  }

  const indexPath = resolve(dashboardRoot, 'index.html');
  const hasIndex = existsSync(indexPath);

  logger.info(`Serving dashboard assets from ${dashboardRoot} at /dashboard`);

  app.get('/dashboard/*', (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Strip /dashboard prefix to get relative path
    const subPath = path.replace(/^\/dashboard\/?/, '') || 'index.html';

    // Try to serve the exact file
    const response = serveFile(dashboardRoot, subPath, c);
    if (response) return response;

    // SPA fallback: serve index.html for non-file paths (client-side routing)
    if (hasIndex && !extname(subPath)) {
      const content = readFileSync(indexPath);
      return c.body(content, 200, { 'Content-Type': 'text/html' });
    }

    return next();
  });

  // Also handle bare /dashboard without trailing slash
  app.get('/dashboard', (c) => {
    if (hasIndex) {
      const content = readFileSync(indexPath);
      return c.body(content, 200, { 'Content-Type': 'text/html' });
    }
    return c.notFound();
  });
}
