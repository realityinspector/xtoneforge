/**
 * Peer Bridge Service
 *
 * Per-workspace service that registers with the peer broker and polls for
 * cross-workspace messages. Messages are injected into a local #cross-workspace
 * channel so the Director can see and respond to them.
 *
 * Follows the DispatchDaemon lifecycle pattern (start/stop/isRunning).
 *
 * @module
 */

import { execSync } from 'node:child_process';
import type { EntityId, ElementId, Channel } from '@stoneforge/core';
import {
  createDocument,
  createMessage,
  createGroupChannel,
  createEntity,
  ContentType,
  EntityTypeValue,
} from '@stoneforge/core';
import type { QuarryAPI, InboxService } from '@stoneforge/quarry';
import { createLogger } from '../utils/logger.js';
import type { PeerInfo, PeerMessage } from './peer-broker.js';

const logger = createLogger('peer-bridge');

// ============================================================================
// Constants
// ============================================================================

const HEARTBEAT_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_RETRIES = 3;
const CROSS_WORKSPACE_CHANNEL_NAME = 'cross-workspace';

// ============================================================================
// Types
// ============================================================================

export interface PeerBridgeConfig {
  workspaceName: string;
  workspacePort: number;
  brokerPort: number;
  api: QuarryAPI;
  inboxService: InboxService;
  projectRoot: string;
  /** Actor entity ID from workspace config (e.g., 'el-1s18') — used as createdBy for injected elements */
  actorId?: string;
}

export interface PeerBridge {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getPeerId(): string | undefined;
  sendMessage(toId: string, text: string): Promise<boolean>;
  listPeers(): Promise<PeerInfo[]>;
}

// ============================================================================
// Helpers
// ============================================================================

function brokerUrl(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

async function brokerFetch<T>(port: number, path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(brokerUrl(port, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await res.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

function gitSummary(workspaceName: string, projectRoot: string): string {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: projectRoot, encoding: 'utf-8', timeout: 3000,
    }).trim();
    return `Workspace ${workspaceName} on ${branch}`;
  } catch {
    return `Workspace ${workspaceName}`;
  }
}

function gitRoot(projectRoot: string): string | null {
  try {
    return execSync('git rev-parse --show-toplevel', {
      cwd: projectRoot, encoding: 'utf-8', timeout: 3000,
    }).trim();
  } catch {
    return null;
  }
}

// ============================================================================
// Implementation
// ============================================================================

export class PeerBridgeImpl implements PeerBridge {
  private peerId: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private crossWorkspaceChannelId: ElementId | undefined;
  private peerEntityCache = new Map<string, EntityId>();
  private systemEntityId: EntityId | undefined;

  constructor(private config: PeerBridgeConfig) {}

  async start(): Promise<void> {
    if (this.running) return;

    // Retry registration with backoff
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const result = await brokerFetch<{ id: string }>(this.config.brokerPort, '/register', {
          name: this.config.workspaceName,
          pid: process.pid,
          port: this.config.workspacePort,
          cwd: this.config.projectRoot,
          git_root: gitRoot(this.config.projectRoot),
          summary: gitSummary(this.config.workspaceName, this.config.projectRoot),
        });
        this.peerId = result.id;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES - 1) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (!this.peerId) {
      logger.warn(`Peer bridge could not connect to broker on port ${this.config.brokerPort}: ${lastError?.message ?? 'unknown error'}. Cross-workspace messaging disabled.`);
      return;
    }

    this.running = true;
    logger.info(`Registered as peer ${this.peerId} with broker on port ${this.config.brokerPort}`);

    // Heartbeat
    this.heartbeatTimer = setInterval(() => {
      brokerFetch(this.config.brokerPort, '/heartbeat', { id: this.peerId }).catch(() => {
        logger.warn('Heartbeat failed');
      });
    }, HEARTBEAT_INTERVAL_MS);

    // Poll for messages
    this.pollTimer = setInterval(() => {
      this.pollMessages().catch((err) => {
        logger.warn('Poll failed:', err instanceof Error ? err.message : String(err));
      });
    }, POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.peerId) {
      try {
        await brokerFetch(this.config.brokerPort, '/unregister', { id: this.peerId });
      } catch {
        // Best-effort unregister
      }
      this.peerId = undefined;
    }
    this.running = false;
    logger.info('Peer bridge stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  getPeerId(): string | undefined {
    return this.peerId;
  }

  async sendMessage(toId: string, text: string): Promise<boolean> {
    if (!this.peerId) return false;
    try {
      const result = await brokerFetch<{ ok: boolean; error?: string }>(
        this.config.brokerPort, '/send-message',
        { from_id: this.peerId, to_id: toId, text }
      );
      return result.ok;
    } catch {
      return false;
    }
  }

  async listPeers(): Promise<PeerInfo[]> {
    if (!this.peerId) return [];
    try {
      return await brokerFetch<PeerInfo[]>(
        this.config.brokerPort, '/list-peers',
        { scope: 'machine', exclude_id: this.peerId }
      );
    } catch {
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private async pollMessages(): Promise<void> {
    if (!this.peerId) return;

    const { messages } = await brokerFetch<{ messages: PeerMessage[] }>(
      this.config.brokerPort, '/poll-messages', { id: this.peerId }
    );

    if (messages.length === 0) return;

    // Look up sender names from broker
    const allPeers = await this.listPeersInternal();
    const peerById = new Map(allPeers.map(p => [p.id, p]));

    for (const msg of messages) {
      try {
        await this.injectMessage(msg, peerById.get(msg.from_id));
      } catch (err) {
        logger.warn(`Failed to inject cross-workspace message from ${msg.from_id}:`, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private async listPeersInternal(): Promise<PeerInfo[]> {
    try {
      return await brokerFetch<PeerInfo[]>(
        this.config.brokerPort, '/list-peers', { scope: 'machine' }
      );
    } catch {
      return [];
    }
  }

  private async ensureSystemEntity(): Promise<EntityId> {
    if (this.systemEntityId) return this.systemEntityId;

    // Use the workspace's configured actor if available
    if (this.config.actorId) {
      this.systemEntityId = this.config.actorId as unknown as EntityId;
      return this.systemEntityId;
    }

    // Create a system entity for cross-workspace operations
    const entityName = `peer-system-${this.config.workspaceName}`;
    const entities = await this.config.api.list<import('@stoneforge/core').Entity>({
      type: 'entity' as import('@stoneforge/core').ElementType,
      tags: ['cross-workspace', 'system'],
    });
    const found = entities.find(e => e.name === entityName);
    if (found) {
      this.systemEntityId = found.id as unknown as EntityId;
      return this.systemEntityId;
    }

    // Bootstrap: create with a self-referencing ID (Quarry allows this for system entities)
    const entity = await createEntity({
      name: entityName,
      entityType: EntityTypeValue.SYSTEM,
      createdBy: entityName as unknown as EntityId, // self-reference for bootstrap
      tags: ['cross-workspace', 'system'],
      metadata: { workspace: this.config.workspaceName },
    });
    const saved = await this.config.api.create(
      entity as unknown as Record<string, unknown> & { createdBy: EntityId }
    );
    this.systemEntityId = saved.id as unknown as EntityId;
    return this.systemEntityId;
  }

  private bridgeEntityId: EntityId | undefined;

  private async ensureBridgeEntity(actorId: EntityId): Promise<EntityId> {
    if (this.bridgeEntityId) return this.bridgeEntityId;

    const entityName = `peer-bridge-${this.config.workspaceName}`;
    const entities = await this.config.api.list<import('@stoneforge/core').Entity>({
      type: 'entity' as import('@stoneforge/core').ElementType,
      tags: ['cross-workspace', 'bridge'],
    });
    const found = entities.find(e => e.name === entityName);
    if (found) {
      this.bridgeEntityId = found.id as unknown as EntityId;
      return this.bridgeEntityId;
    }

    const entity = await createEntity({
      name: entityName,
      entityType: EntityTypeValue.SYSTEM,
      createdBy: actorId,
      tags: ['cross-workspace', 'bridge'],
      metadata: { workspace: this.config.workspaceName },
    });
    const saved = await this.config.api.create(
      entity as unknown as Record<string, unknown> & { createdBy: EntityId }
    );
    this.bridgeEntityId = saved.id as unknown as EntityId;
    return this.bridgeEntityId;
  }

  private async ensurePeerEntity(peerName: string): Promise<EntityId> {
    const cached = this.peerEntityCache.get(peerName);
    if (cached) return cached;

    // For MVP, use the system entity as sender for all cross-workspace messages
    // This avoids needing to create separate entities per remote workspace
    const systemId = await this.ensureSystemEntity();
    this.peerEntityCache.set(peerName, systemId);
    return systemId;
  }

  private async ensureCrossWorkspaceChannel(): Promise<ElementId> {
    if (this.crossWorkspaceChannelId) return this.crossWorkspaceChannelId;

    // Try to find existing channel
    const channels = await this.config.api.searchChannels(CROSS_WORKSPACE_CHANNEL_NAME);
    const existing = channels.find((c: Channel) => c.name === CROSS_WORKSPACE_CHANNEL_NAME);

    if (existing) {
      this.crossWorkspaceChannelId = existing.id as unknown as ElementId;
      return this.crossWorkspaceChannelId;
    }

    // Create the channel — GROUP requires at least 2 members
    // Create a bridge entity as the second member
    const systemActor = await this.ensureSystemEntity();
    const bridgeEntity = await this.ensureBridgeEntity(systemActor);
    const channel = await createGroupChannel({
      name: CROSS_WORKSPACE_CHANNEL_NAME,
      createdBy: systemActor,
      members: [systemActor, bridgeEntity],
      description: 'Cross-workspace peer messages',
      tags: ['cross-workspace', 'auto-created'],
      metadata: { peerBridge: true },
    });

    const saved = await this.config.api.create(
      channel as unknown as Record<string, unknown> & { createdBy: EntityId }
    );
    this.crossWorkspaceChannelId = saved.id as unknown as ElementId;
    return this.crossWorkspaceChannelId;
  }

  private async injectMessage(msg: PeerMessage, senderPeer?: PeerInfo): Promise<void> {
    const senderName = senderPeer?.name ?? msg.from_id;
    const senderId = await this.ensurePeerEntity(senderName);
    const channelId = await this.ensureCrossWorkspaceChannel();

    // Create document for message content
    const prefix = senderPeer ? `[${senderPeer.name}]` : `[peer:${msg.from_id}]`;
    const contentDoc = await createDocument({
      contentType: ContentType.TEXT,
      content: `${prefix} ${msg.text}`,
      createdBy: senderId,
      tags: ['cross-workspace'],
      metadata: { fromPeerId: msg.from_id, fromWorkspace: senderName },
    });
    const savedDoc = await this.config.api.create(
      contentDoc as unknown as Record<string, unknown> & { createdBy: EntityId }
    );

    // Create message in the cross-workspace channel
    const message = await createMessage({
      channelId: channelId as unknown as import('@stoneforge/core').ChannelId,
      sender: senderId,
      contentRef: savedDoc.id as unknown as import('@stoneforge/core').DocumentId,
      tags: ['cross-workspace'],
      metadata: {
        fromPeerId: msg.from_id,
        fromWorkspace: senderName,
        sentAt: msg.sent_at,
      },
    });
    await this.config.api.create(
      message as unknown as Record<string, unknown> & { createdBy: EntityId }
    );

    logger.info(`Injected cross-workspace message from ${senderName}`);
  }
}

// ============================================================================
// Factory
// ============================================================================

export function createPeerBridge(config: PeerBridgeConfig): PeerBridge {
  return new PeerBridgeImpl(config);
}
