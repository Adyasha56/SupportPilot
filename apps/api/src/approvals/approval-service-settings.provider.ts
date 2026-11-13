import { Provider } from '@nestjs/common';
import { APPROVAL_SERVICE_SETTINGS, ApprovalServiceSettings } from './approval.service';
import { loadApprovalServiceSettingsFromEnv } from './approval-service.settings';

export const approvalServiceSettingsProvider: Provider = {
  provide: APPROVAL_SERVICE_SETTINGS,
  useFactory: (): ApprovalServiceSettings => loadApprovalServiceSettingsFromEnv(process.env),
};
