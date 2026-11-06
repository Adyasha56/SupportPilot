import { randomUUID } from 'node:crypto';
import { AgentRunRecord, AgentRunRepository, NewAgentRun } from '../agent-run.repository';

export class InMemoryAgentRunRepository implements AgentRunRepository {
  private readonly runs: AgentRunRecord[] = [];

  async create(run: NewAgentRun): Promise<AgentRunRecord> {
    const record: AgentRunRecord = {
      id: randomUUID(),
      ...run,
      degraded: run.degraded ?? null,
      proposedAction: run.proposedAction ?? null,
      createdAt: new Date(),
    };
    this.runs.push(record);
    return record;
  }

  async findByConversation(tenantId: string, conversationId: string): Promise<AgentRunRecord[]> {
    return this.runs
      .filter((r) => r.tenantId === tenantId && r.conversationId === conversationId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async deleteForTenant(tenantId: string): Promise<void> {
    for (let i = this.runs.length - 1; i >= 0; i--) {
      if (this.runs[i].tenantId === tenantId) {
        this.runs.splice(i, 1);
      }
    }
  }
}
