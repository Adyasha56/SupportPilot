import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import { ConnectorConfig, ConnectorListResponse, ConnectorSummary } from '@supportpilot/shared';
import { AdminAuthGuard, AdminPrincipal } from '../admin-auth/admin-auth.guard';
import { CurrentAdminPrincipal } from '../admin-auth/current-admin-principal.decorator';
import { ConnectorConfigNotFoundError, ConnectorConfigRepository } from './connector-config.repository';
import { CONNECTOR_CONFIG_REPOSITORY } from './connector-config-repository.provider';

/** Exported for its own unit test - never includes secretRef, the request block, inputSchema, responseMap, or idPattern, only ever tool/description. */
export function toConnectorSummary(config: ConnectorConfig): ConnectorSummary {
  return { tool: config.tool, description: config.description };
}

/**
 * Stage 1c, item 4 - no `@RequireScope` override, so `AdminAuthGuard`'s own
 * default minimum (`admin`) applies, same as approvals/conversations/
 * settings. Read-only: editing configs and testing a tool call from the
 * console are deferred (PROJECT.md section 7/12) - connector configs live
 * in files, not the database, so there is no write path here at all.
 * `findAllForTenant` never throws when connectors are globally disabled
 * (`DisabledConnectorConfigRepository` returns an empty list) - but
 * `FileConnectorConfigRepository` DOES throw `ConnectorConfigNotFoundError`
 * for a tenant with no fixtures directory of its own yet (connector-
 * config.repository.ts), which is an entirely normal state for a tenant
 * that simply hasn't been given any connectors - caught here and treated
 * identically to "zero connectors", never surfaced as an error. There is
 * no `NOT_CONFIGURED` case for this route at all, unlike the
 * database-backed admin surfaces.
 */
@Controller('v1/connectors')
@UseGuards(AdminAuthGuard)
export class ConnectorsAdminController {
  constructor(@Inject(CONNECTOR_CONFIG_REPOSITORY) private readonly repository: ConnectorConfigRepository) {}

  @Get()
  list(@CurrentAdminPrincipal() principal: AdminPrincipal): ConnectorListResponse {
    try {
      return { connectors: this.repository.findAllForTenant(principal.tenantId).map(toConnectorSummary) };
    } catch (err) {
      if (err instanceof ConnectorConfigNotFoundError) {
        return { connectors: [] };
      }
      throw err;
    }
  }
}
