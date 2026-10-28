import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ClientSession, Model, Types } from 'mongoose';
import { PolicyFailureCode } from '@supportpilot/shared';
import { PolicyDocumentDocument, PolicyDocumentStatus } from './schemas/policy-document.schema';

export interface PolicyDocumentRecord {
  id: string;
  tenantId: string;
  title: string;
  status: PolicyDocumentStatus;
  contentHash: string;
  chunkCount: number;
  failureCode: PolicyFailureCode | null;
  uploadedAt: Date;
}

export interface PolicyDocumentRepository {
  create(tenantId: string, title: string, contentHash: string): Promise<PolicyDocumentRecord>;
  markReady(tenantId: string, id: string, chunkCount: number, session?: ClientSession): Promise<void>;
  markFailed(tenantId: string, id: string, failureCode: PolicyFailureCode): Promise<void>;
  findAllForTenant(tenantId: string): Promise<PolicyDocumentRecord[]>;
  findById(tenantId: string, id: string): Promise<PolicyDocumentRecord | null>;
  /** Scoped per tenant - the same content hash recurring across different tenants is expected and not a duplicate. Matches 'pending' or 'ready' only; a 'failed' document never blocks a retry. */
  findByContentHash(tenantId: string, contentHash: string): Promise<PolicyDocumentRecord | null>;
  /** Counts 'pending' + 'ready' documents only - a 'failed' document shouldn't count against the quota and block every retry. */
  countActiveForTenant(tenantId: string): Promise<number>;
  delete(tenantId: string, id: string): Promise<boolean>;
  /** Used by the stale-pending cleanup sweep to fail documents stuck past the ingestion deadline (e.g. a crash mid-pipeline). */
  findStalePending(olderThan: Date): Promise<PolicyDocumentRecord[]>;
}

export const POLICY_DOCUMENT_REPOSITORY = Symbol('POLICY_DOCUMENT_REPOSITORY');

function toRecord(doc: PolicyDocumentDocument): PolicyDocumentRecord {
  return {
    id: doc._id.toString(),
    tenantId: doc.tenantId,
    title: doc.title,
    status: doc.status,
    contentHash: doc.contentHash,
    chunkCount: doc.chunkCount,
    failureCode: doc.failureCode,
    uploadedAt: doc.uploadedAt,
  };
}

@Injectable()
export class MongoosePolicyDocumentRepository implements PolicyDocumentRepository {
  constructor(@InjectModel('PolicyDocument') private readonly model: Model<PolicyDocumentDocument>) {}

  async create(tenantId: string, title: string, contentHash: string): Promise<PolicyDocumentRecord> {
    const doc = await this.model.create({ tenantId, title, contentHash, status: 'pending', chunkCount: 0, failureCode: null });
    return toRecord(doc);
  }

  async markReady(tenantId: string, id: string, chunkCount: number, session?: ClientSession): Promise<void> {
    await this.model.updateOne(
      { _id: id, tenantId },
      { $set: { status: 'ready', chunkCount, failureCode: null } },
      { session },
    );
  }

  async markFailed(tenantId: string, id: string, failureCode: PolicyFailureCode): Promise<void> {
    await this.model.updateOne({ _id: id, tenantId }, { $set: { status: 'failed', failureCode } });
  }

  async findAllForTenant(tenantId: string): Promise<PolicyDocumentRecord[]> {
    const docs = await this.model.find({ tenantId }).sort({ uploadedAt: -1 }).lean();
    return docs.map((doc) => toRecord(doc as unknown as PolicyDocumentDocument));
  }

  async findById(tenantId: string, id: string): Promise<PolicyDocumentRecord | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    const doc = await this.model.findOne({ _id: id, tenantId }).lean();
    return doc ? toRecord(doc as unknown as PolicyDocumentDocument) : null;
  }

  async findByContentHash(tenantId: string, contentHash: string): Promise<PolicyDocumentRecord | null> {
    const doc = await this.model.findOne({ tenantId, contentHash, status: { $in: ['pending', 'ready'] } }).lean();
    return doc ? toRecord(doc as unknown as PolicyDocumentDocument) : null;
  }

  async countActiveForTenant(tenantId: string): Promise<number> {
    return this.model.countDocuments({ tenantId, status: { $in: ['pending', 'ready'] } });
  }

  async delete(tenantId: string, id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) {
      return false;
    }
    const result = await this.model.deleteOne({ _id: id, tenantId });
    return result.deletedCount > 0;
  }

  async findStalePending(olderThan: Date): Promise<PolicyDocumentRecord[]> {
    const docs = await this.model.find({ status: 'pending', uploadedAt: { $lt: olderThan } }).lean();
    return docs.map((doc) => toRecord(doc as unknown as PolicyDocumentDocument));
  }
}
