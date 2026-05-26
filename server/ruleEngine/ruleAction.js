import { randomUUID } from 'node:crypto';

export function createRuleAction(input = {}) {
  return {
    id: String(input.id || randomUUID()),
    type: String(input.type || 'entry_exit'),
    direction: String(input.direction || 'neutral'),
    entryLogic: String(input.entryLogic || ''),
    exitLogic: String(input.exitLogic || ''),
    stopLossLogic: String(input.stopLossLogic || ''),
    takeProfitLogic: String(input.takeProfitLogic || ''),
    invalidationCondition: String(input.invalidationCondition || ''),
    riskRules: input.riskRules && typeof input.riskRules === 'object' ? input.riskRules : {},
  };
}
