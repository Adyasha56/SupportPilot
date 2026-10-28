import { SetMetadata } from '@nestjs/common';
import { ApiKeyScope } from '../db/schemas/api-key.schema';

export const REQUIRE_SCOPE_KEY = 'requireScope';

/** Marks a route as requiring the given ApiKeyScope, checked by ApiKeyGuard. */
export const RequireScope = (scope: ApiKeyScope) => SetMetadata(REQUIRE_SCOPE_KEY, scope);
