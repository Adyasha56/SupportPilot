import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PolicyDocumentSummary } from '@supportpilot/shared';
import { ApiKeyGuard } from '../auth/api-key.guard';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { RequireScope } from '../auth/require-scope.decorator';
import { POLICY_CHUNK_REPOSITORY, PolicyChunkRepository } from '../db/policy-chunk.repository';
import { POLICY_DOCUMENT_REPOSITORY, PolicyDocumentRecord, PolicyDocumentRepository } from '../db/policy-document.repository';
import { INGESTION_SETTINGS } from './ingestion-settings.provider';
import { IngestionSettings } from './ingestion.settings';
import { MemoryUploadedFile } from './memory-uploaded-file';
import { MulterExceptionFilter } from './multer-exception.filter';
import { PolicyIngestionService } from './policy-ingestion.service';
import { policyHttpError } from './policy-error.http';
import { containsNulByte, decodeStrictUtf8, hasAllowedExtension, sanitizeTitle } from './upload-validation';

const MULTER_LIMITS = {
  fileSize: 1_000_000,
  files: 1,
  fields: 1, // just "title"
  fieldSize: 2_000,
  fieldNameSize: 100,
  parts: 3,
};

/**
 * multer's own memoryStorage() can't be imported directly - multer isn't a
 * direct dependency of this package (only present transitively via
 * @nestjs/platform-express, and not resolvable from apps/api's own
 * node_modules - confirmed directly), and @types/multer was deliberately
 * not added for this one function either. Replicates multer's own
 * memoryStorage implementation exactly (buffer the file stream, set
 * `buffer`/`size` on the file object) - multer's StorageEngine contract is
 * just two callback-based methods, not worth a dependency for.
 */
const inMemoryStorageEngine = {
  _handleFile(
    _req: unknown,
    file: { stream: NodeJS.ReadableStream },
    callback: (error: Error | null, info?: { buffer: Buffer; size: number }) => void,
  ): void {
    const chunks: Buffer[] = [];
    file.stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    file.stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      callback(null, { buffer, size: buffer.length });
    });
    file.stream.on('error', (err: Error) => callback(err));
  },
  _removeFile(_req: unknown, file: { buffer?: Buffer }, callback: (error: Error | null) => void): void {
    delete file.buffer;
    callback(null);
  },
};

function toSummary(doc: PolicyDocumentRecord): PolicyDocumentSummary {
  return {
    id: doc.id,
    title: doc.title,
    status: doc.status,
    failureCode: doc.failureCode,
    uploadedAt: doc.uploadedAt.toISOString(),
    chunkCount: doc.chunkCount,
  };
}

@Controller('v1/policies')
@UseGuards(ApiKeyGuard)
@RequireScope('secret')
@UseFilters(MulterExceptionFilter)
export class PoliciesController {
  private readonly logger = new Logger(PoliciesController.name);

  constructor(
    @Inject(INGESTION_SETTINGS) private readonly settings: IngestionSettings,
    private readonly ingestionService: PolicyIngestionService,
    @Optional() @Inject(POLICY_DOCUMENT_REPOSITORY) private readonly documentRepository?: PolicyDocumentRepository,
    @Optional() @Inject(POLICY_CHUNK_REPOSITORY) private readonly chunkRepository?: PolicyChunkRepository,
  ) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { storage: inMemoryStorageEngine, limits: MULTER_LIMITS }))
  async upload(
    @CurrentTenant() tenantId: string,
    @UploadedFile() file: MemoryUploadedFile | undefined,
    @Body('title') rawTitle: string | undefined,
  ): Promise<PolicyDocumentSummary> {
    const startedAt = Date.now();

    if (!file) {
      throw policyHttpError('INVALID_CONTENT', 'A file is required (multipart field "file").');
    }
    if (!hasAllowedExtension(file.originalname)) {
      throw policyHttpError('INVALID_FILE_TYPE', 'Only .md and .txt files are accepted.');
    }
    // Belt-and-suspenders against multer's own stream-level fileSize limit -
    // that limit truncates/aborts the stream, this checks the fully
    // buffered result is also within bounds.
    if (file.size > this.settings.maxFileBytes) {
      throw policyHttpError('FILE_TOO_LARGE', `File exceeds the ${this.settings.maxFileBytes}-byte limit.`);
    }

    const text = decodeStrictUtf8(file.buffer);
    if (text === null) {
      throw policyHttpError('INVALID_ENCODING', 'File is not valid UTF-8.');
    }
    if (containsNulByte(text)) {
      throw policyHttpError('INVALID_CONTENT', 'File contains a NUL byte.');
    }

    const title = sanitizeTitle(rawTitle, this.settings.titleMaxLength);

    const result = await this.ingestionService.ingest({ tenantId, text, title });
    const durationMs = Date.now() - startedAt;

    if (!result.ok) {
      this.logger.log(
        JSON.stringify({ event: 'policy_upload', tenantId, outcome: result.code, durationMs }),
      );
      throw policyHttpError(result.code, result.message, result.existingDocumentId);
    }

    this.logger.log(
      JSON.stringify({
        event: 'policy_upload',
        tenantId,
        documentId: result.document.id,
        outcome: 'ready',
        chunkCount: result.document.chunkCount,
        durationMs,
      }),
    );
    return toSummary(result.document);
  }

  @Get()
  async list(@CurrentTenant() tenantId: string): Promise<PolicyDocumentSummary[]> {
    if (!this.documentRepository) {
      throw policyHttpError('NOT_CONFIGURED', 'The database is not configured.');
    }
    const docs = await this.documentRepository.findAllForTenant(tenantId);
    return docs.map(toSummary);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentTenant() tenantId: string, @Param('id') id: string): Promise<void> {
    if (!this.documentRepository || !this.chunkRepository) {
      throw policyHttpError('NOT_CONFIGURED', 'The database is not configured.');
    }

    const existing = await this.documentRepository.findById(tenantId, id);
    if (!existing) {
      // Identical 404 whether the id belongs to another tenant or doesn't
      // exist at all - never reveals which, same principle as the auth
      // guard's identical generic 401 for every failure mode.
      throw new NotFoundException();
    }

    // Deactivate first, so retrieval stops seeing these chunks immediately,
    // even if the process crashes between these two calls.
    await this.chunkRepository.deactivateForDocument(tenantId, id);
    await this.chunkRepository.deleteForDocument(tenantId, id);
    await this.documentRepository.delete(tenantId, id);

    this.logger.log(JSON.stringify({ event: 'policy_delete', tenantId, documentId: id }));
  }
}
