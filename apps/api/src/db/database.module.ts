import { Module, Provider } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { TenantSchema } from './schemas/tenant.schema';
import { PolicyDocumentSchema } from './schemas/policy-document.schema';
import { PolicyChunkSchema } from './schemas/policy-chunk.schema';
import { ApiKeySchema } from './schemas/api-key.schema';
import { MongooseTenantRepository, TENANT_REPOSITORY } from './tenant.repository';
import { MongooseApiKeyRepository, API_KEY_REPOSITORY } from './api-key.repository';
import { MongoosePolicyDocumentRepository, POLICY_DOCUMENT_REPOSITORY } from './policy-document.repository';
import { MongoosePolicyChunkRepository, POLICY_CHUNK_REPOSITORY } from './policy-chunk.repository';

const repositoryProviders: Provider[] = [
  { provide: TENANT_REPOSITORY, useClass: MongooseTenantRepository },
  { provide: API_KEY_REPOSITORY, useClass: MongooseApiKeyRepository },
  { provide: POLICY_DOCUMENT_REPOSITORY, useClass: MongoosePolicyDocumentRepository },
  { provide: POLICY_CHUNK_REPOSITORY, useClass: MongoosePolicyChunkRepository },
];

/**
 * Only ever imported by AppModule when process.env.MONGODB_URI is set (see
 * app.module.ts) - so this module can assume a URI is present and never
 * needs to handle "no database configured" itself. It only connects and
 * registers schemas; it NEVER creates or modifies Search/Vector indexes -
 * that is exclusively the `db:ensure-indexes` script's job, run manually,
 * never from the app's own boot path.
 */
@Module({
  imports: [
    // serverSelectionTimeoutMS: without this, a wrong/unreachable
    // MONGODB_URI hangs the whole app at boot with ZERO log output (not
    // even Nest's own startup line) - confirmed directly. 5s fails loudly
    // instead of hanging silently.
    //
    // autoIndex: false - explicit, not relying on Mongoose's own default
    // (true). Index creation (both this unique index on ApiKey.hash and the
    // Atlas Vector Search index on PolicyChunk) is exclusively the
    // `db:ensure-indexes` script's job, run manually, never from the app's
    // own boot path - same rule already applied to the Vector index,
    // extended here to ordinary indexes too, so there's one script and one
    // mental model for all index management instead of two.
    MongooseModule.forRoot(process.env.MONGODB_URI as string, {
      serverSelectionTimeoutMS: 5000,
      autoIndex: false,
    }),
    MongooseModule.forFeature([
      { name: 'Tenant', schema: TenantSchema },
      { name: 'PolicyDocument', schema: PolicyDocumentSchema },
      { name: 'PolicyChunk', schema: PolicyChunkSchema },
      { name: 'ApiKey', schema: ApiKeySchema },
    ]),
  ],
  providers: repositoryProviders,
  exports: [
    MongooseModule,
    TENANT_REPOSITORY,
    API_KEY_REPOSITORY,
    POLICY_DOCUMENT_REPOSITORY,
    POLICY_CHUNK_REPOSITORY,
  ],
})
export class DatabaseModule {}
