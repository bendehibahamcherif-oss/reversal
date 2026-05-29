const ALLOWED_SOURCES = new Set(['alpha', 'pattern', 'quantFeature', 'qualityScore', 'analytics', 'backtest', 'strategy', 'sessionContext']);
const ALLOWED_OPERATORS = new Set(['>', '>=', '<', '<=', '==', '!=', 'contains', 'exists']);
const ALLOWED_LOGIC = new Set(['AND', 'OR']);
const ALLOWED_STATUS = new Set(['draft', 'research_only', 'archived']);
const NUMERIC_OPERATORS = new Set(['>', '>=', '<', '<=']);

export const LEGAL_DISCLAIMER =
  'RESEARCH & EDUCATIONAL USE ONLY. This rule set and any associated backtest or preview output are provided for ' +
  'research and educational purposes only. Past performance does not guarantee future results. This output is NOT ' +
  'financial advice, is NOT a recommendation to buy or sell any security, and has NOT been validated for live ' +
  'trading. Use at your own risk. Always consult a qualified financial professional before making investment decisions.';

class ValidationEngine {
  validate(ruleSet) {
    const warnings = {};
    const errors = {};

    const warn = (path, msg) => { (warnings[path] ??= []).push(msg); };
    const err  = (path, msg) => { (errors[path]   ??= []).push(msg); };

    if (!ruleSet.symbol) err('symbol', 'Symbol is required');

    if (!ruleSet.name || ruleSet.name === 'Unnamed Rule Set') {
      warn('name', 'Provide a descriptive name for this rule set');
    }

    if (!ALLOWED_STATUS.has(String(ruleSet.status || ''))) {
      err('status', `Invalid status. Allowed: ${[...ALLOWED_STATUS].join(', ')}`);
    }

    // Collect conditions from both flat array and conditionGroups
    const flatConditions = Array.isArray(ruleSet.conditions) ? [...ruleSet.conditions] : [];

    if (Array.isArray(ruleSet.conditionGroups) && ruleSet.conditionGroups.length > 0) {
      ruleSet.conditionGroups.forEach((group, gi) => {
        const gp = `conditionGroups[${gi}]`;
        if (!group.id) warn(gp, 'Group is missing an id');

        if (!ALLOWED_LOGIC.has(String(group.logic || ''))) {
          err(`${gp}.logic`, `Invalid group logic "${group.logic}". Allowed: AND, OR`);
        }

        if (!Array.isArray(group.conditions) || group.conditions.length === 0) {
          warn(gp, 'Group has no conditions; it will trivially pass (AND) or fail (OR)');
        } else {
          flatConditions.push(...group.conditions);
        }
      });
    }

    if (flatConditions.length === 0) {
      warn('conditions', 'Rule set has no conditions; evaluation will trivially pass');
    }

    const seenIds = new Set();
    flatConditions.forEach((c, ci) => {
      const cp = `conditions[${ci}]`;

      if (!c.id) {
        warn(cp, 'Condition is missing an id');
      } else if (seenIds.has(c.id)) {
        err(cp, `Duplicate condition id: ${c.id}`);
      } else {
        seenIds.add(c.id);
      }

      if (!ALLOWED_SOURCES.has(String(c.source || ''))) {
        err(`${cp}.source`, `Invalid source "${c.source}". Allowed: ${[...ALLOWED_SOURCES].join(', ')}`);
      }

      if (!ALLOWED_OPERATORS.has(String(c.operator || ''))) {
        err(`${cp}.operator`, `Invalid operator "${c.operator}"`);
      }

      if (!c.field && c.operator !== 'exists') {
        warn(`${cp}.field`, `Field is empty; only "exists" operator is meaningful without a field`);
      }

      if (NUMERIC_OPERATORS.has(c.operator) && c.value == null) {
        warn(`${cp}.value`, `Operator "${c.operator}" requires a numeric value`);
      }
    });

    if (!Array.isArray(ruleSet.actions) || ruleSet.actions.length === 0) {
      warn('actions', 'No actions defined; rule set cannot generate entry/exit signals');
    }

    if (!ruleSet.riskRules || typeof ruleSet.riskRules !== 'object' || Object.keys(ruleSet.riskRules).length === 0) {
      warn('riskRules', 'No risk rules defined; add stop-loss and position-sizing rules before any live use');
    }

    const disclaimerAccepted = ruleSet.disclaimerAccepted === true;
    if (!disclaimerAccepted) {
      warn('disclaimerAccepted', 'Legal disclaimer has not been accepted; preview backtest will be blocked until accepted');
    }

    return {
      valid: Object.keys(errors).length === 0,
      errors,
      warnings,
      disclaimerAccepted,
    };
  }

  evaluateGroups(conditionGroups, ctx, evaluateConditionFn) {
    if (!Array.isArray(conditionGroups) || conditionGroups.length === 0) return [];

    return conditionGroups.map((group) => {
      const results = (Array.isArray(group.conditions) ? group.conditions : []).map(
        (c) => evaluateConditionFn(c, ctx),
      );
      const logic = String(group.logic || 'AND').toUpperCase();
      const passed = logic === 'OR'
        ? results.some((r) => r.passed)
        : results.every((r) => r.passed);
      return { groupId: group.id, logic, passed, results };
    });
  }
}

export const validationEngine = new ValidationEngine();
