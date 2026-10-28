import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { ApiKeyDocument, ApiKeyScope } from './schemas/api-key.schema';

export interface ApiKeyLookup {
  id: string;
  tenantId: string;
  scopes: ApiKeyScope[];
  revokedAt: Date | null;
  /** Included so callers can do their own explicit timingSafeEqual check, not just trust the DB's equality match. */
  hash: string;
}

export interface ApiKeyRepository {
  create(tenantId: string, hash: string, keyPrefix: string, scopes: ApiKeyScope[]): Promise<string>;
  findByHash(hash: string): Promise<ApiKeyLookup | null>;
  revoke(id: string): Promise<boolean>;
}

export const API_KEY_REPOSITORY = Symbol('API_KEY_REPOSITORY');

@Injectable()
export class MongooseApiKeyRepository implements ApiKeyRepository {
  constructor(@InjectModel('ApiKey') private readonly model: Model<ApiKeyDocument>) {}

  async create(tenantId: string, hash: string, keyPrefix: string, scopes: ApiKeyScope[]): Promise<string> {
    const doc = await this.model.create({ tenantId, hash, keyPrefix, scopes, revokedAt: null });
    return doc._id.toString();
  }

  async findByHash(hash: string): Promise<ApiKeyLookup | null> {
    const doc = await this.model.findOne({ hash }).select('+hash').lean();
    return doc
      ? { id: doc._id.toString(), tenantId: doc.tenantId, scopes: doc.scopes, revokedAt: doc.revokedAt, hash: doc.hash }
      : null;
  }

  async revoke(id: string): Promise<boolean> {
    if (!Types.ObjectId.isValid(id)) {
      return false;
    }
    const result = await this.model.updateOne({ _id: id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return result.modifiedCount > 0;
  }
}
