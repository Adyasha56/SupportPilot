import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PolicyDocumentDocument, PolicyDocumentStatus } from './schemas/policy-document.schema';

export interface PolicyDocumentRecord {
  id: string;
  tenantId: string;
  title: string;
  status: PolicyDocumentStatus;
  chunkCount: number;
  uploadedAt: Date;
}

export interface PolicyDocumentRepository {
  create(tenantId: string, title: string): Promise<PolicyDocumentRecord>;
  markReady(tenantId: string, id: string, chunkCount: number): Promise<void>;
  markFailed(tenantId: string, id: string): Promise<void>;
  findAllForTenant(tenantId: string): Promise<PolicyDocumentRecord[]>;
  findById(tenantId: string, id: string): Promise<PolicyDocumentRecord | null>;
  delete(tenantId: string, id: string): Promise<boolean>;
  /** Used in a later stage to fail stale pending documents past an ingestion deadline. */
  findStalePending(olderThan: Date): Promise<PolicyDocumentRecord[]>;
}

export const POLICY_DOCUMENT_REPOSITORY = Symbol('POLICY_DOCUMENT_REPOSITORY');

function toRecord(doc: PolicyDocumentDocument): PolicyDocumentRecord {
  return {
    id: doc._id.toString(),
    tenantId: doc.tenantId,
    title: doc.title,
    status: doc.status,
    chunkCount: doc.chunkCount,
    uploadedAt: doc.uploadedAt,
  };
}

@Injectable()
export class MongoosePolicyDocumentRepository implements PolicyDocumentRepository {
  constructor(@InjectModel('PolicyDocument') private readonly model: Model<PolicyDocumentDocument>) {}

  async create(tenantId: string, title: string): Promise<PolicyDocumentRecord> {
    const doc = await this.model.create({ tenantId, title, status: 'pending', chunkCount: 0 });
    return toRecord(doc);
  }

  async markReady(tenantId: string, id: string, chunkCount: number): Promise<void> {
    await this.model.updateOne({ _id: id, tenantId }, { $set: { status: 'ready', chunkCount } });
  }

  async markFailed(tenantId: string, id: string): Promise<void> {
    await this.model.updateOne({ _id: id, tenantId }, { $set: { status: 'failed' } });
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
