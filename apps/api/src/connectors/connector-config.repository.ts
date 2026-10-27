import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  ConnectorConfig,
  ConnectorConfigSchema,
  TENANT_ID_PATTERN,
  TOOL_INPUT_SCHEMAS,
} from '@supportpilot/shared';

/** Generous for a tiny connector config; rejects anything absurdly large. */
export const MAX_CONFIG_FILE_BYTES = 10 * 1024;

export class ConnectorConfigNotFoundError extends Error {
  readonly code = 'CONNECTOR_CONFIG_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorConfigNotFoundError';
  }
}

export class InvalidConnectorConfigError extends Error {
  readonly code = 'INVALID_CONNECTOR_CONFIG';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidConnectorConfigError';
  }
}

export class TenantMismatchError extends Error {
  readonly code = 'TENANT_MISMATCH';
  constructor(message: string) {
    super(message);
    this.name = 'TenantMismatchError';
  }
}

export interface ConnectorConfigRepository {
  findAllForTenant(tenantId: string): ConnectorConfig[];
  findByTool(tenantId: string, tool: string): ConnectorConfig;
}

/**
 * File-backed implementation, standing in for the future DB-backed
 * ConnectorConfig table (PROJECT.md section 5). Swappable behind the
 * interface above without touching any caller.
 */
export class FileConnectorConfigRepository implements ConnectorConfigRepository {
  private readonly fixturesRoot: string;

  constructor(fixturesRoot: string) {
    this.fixturesRoot = resolve(fixturesRoot);
  }

  findAllForTenant(tenantId: string): ConnectorConfig[] {
    // Validate BEFORE any filesystem access - most traversal attempts
    // (.., /, \, %, :) are already rejected here, since none of those
    // characters are in the allowed charset.
    if (!TENANT_ID_PATTERN.test(tenantId)) {
      throw new ConnectorConfigNotFoundError('Invalid tenant id');
    }

    const tenantDir = this.resolveTenantDir(tenantId);

    let entries: string[];
    try {
      entries = readdirSync(tenantDir);
    } catch {
      throw new ConnectorConfigNotFoundError('No connector configs for tenant');
    }

    const configs: ConnectorConfig[] = [];
    const seenTools = new Set<string>();

    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue; // ignore non-JSON files
      }

      const filePath = join(tenantDir, entry);

      const stats = statSync(filePath);
      if (stats.size > MAX_CONFIG_FILE_BYTES) {
        throw new InvalidConnectorConfigError(`Connector config file exceeds the size cap: ${entry}`);
      }

      const raw = readFileSync(filePath, 'utf-8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new InvalidConnectorConfigError(`Malformed JSON in connector config file: ${entry}`);
      }

      const result = ConnectorConfigSchema.safeParse(parsed);
      if (!result.success) {
        throw new InvalidConnectorConfigError(`Connector config failed schema validation: ${entry}`);
      }

      const config = result.data;

      if (config.tenantId !== tenantId) {
        throw new TenantMismatchError("Connector config's tenantId does not match its folder");
      }

      if (seenTools.has(config.tool)) {
        throw new InvalidConnectorConfigError(`Duplicate tool "${config.tool}" for tenant`);
      }
      seenTools.add(config.tool);

      this.validateRequestBody(config, entry);

      configs.push(config);
    }

    return configs;
  }

  findByTool(tenantId: string, tool: string): ConnectorConfig {
    const configs = this.findAllForTenant(tenantId);
    const match = configs.find((config) => config.tool === tool);
    if (!match) {
      throw new ConnectorConfigNotFoundError(`No connector config for tool "${tool}"`);
    }
    return match;
  }

  /**
   * GET requests must have no body. Every value in a POST body mapping
   * (the input argument name it draws from) must be a real field of that
   * tool's input schema - the schema itself doesn't know which tool it
   * belongs to, so this cross-check only happens here.
   */
  private validateRequestBody(config: ConnectorConfig, entry: string): void {
    const { method, body } = config.request;

    if (method === 'GET') {
      if (body) {
        throw new InvalidConnectorConfigError(`GET connector config must not have a body: ${entry}`);
      }
      return;
    }

    if (!body) {
      return;
    }

    const inputSchema = TOOL_INPUT_SCHEMAS[config.tool];
    const validArgNames = new Set(Object.keys(inputSchema.shape));

    for (const argName of Object.values(body)) {
      if (!validArgNames.has(argName)) {
        throw new InvalidConnectorConfigError(
          `Connector config's request.body references an unknown input argument "${argName}": ${entry}`,
        );
      }
    }
  }

  /**
   * Resolves tenantId onto the fixtures root and verifies the result still
   * lives inside it - defense in depth behind the regex check above.
   */
  private resolveTenantDir(tenantId: string): string {
    const candidate = resolve(join(this.fixturesRoot, tenantId));
    const boundary = this.fixturesRoot + sep;
    if (candidate !== this.fixturesRoot && !candidate.startsWith(boundary)) {
      throw new ConnectorConfigNotFoundError('Resolved path escapes the fixtures root');
    }
    return candidate;
  }
}
