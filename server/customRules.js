// Section 16, Category 19: a real, working no-code rule engine. Unlike every detector in
// server/rules/, a custom rule isn't a file -- it's a row in custom_rules, defined declaratively
// via POST /custom-rules and evaluated generically here against any transaction field. This is
// the actual substance of "Auto Rule Builder"/"No-Code Rule Engine": a new detection rule can be
// added without writing or deploying any code.
const ALLOWED_FIELDS = ['amount', 'country', 'ip_address', 'transaction_type', 'purpose', 'device_id', 'merchant_id', 'employee_id'];
const ALLOWED_OPERATORS = ['>', '>=', '<', '<=', '==', '!=', 'contains'];

function coerceForComparison(fieldValue, ruleValue) {
  if (typeof fieldValue === 'number') {
    return [fieldValue, Number(ruleValue)];
  }
  return [String(fieldValue ?? '').toLowerCase(), String(ruleValue).toLowerCase()];
}

function evaluateOperator(operator, fieldValue, ruleValue) {
  if (fieldValue === undefined || fieldValue === null) return false;
  const [left, right] = coerceForComparison(fieldValue, ruleValue);

  switch (operator) {
    case '>':
      return left > right;
    case '>=':
      return left >= right;
    case '<':
      return left < right;
    case '<=':
      return left <= right;
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case 'contains':
      return String(left).includes(String(right));
    default:
      return false;
  }
}

/**
 * @param {object} transaction - the validated POST /transaction input
 * @param {Array<{rule_id: string, name: string, field: string, operator: string, value: string, weight: number, severity: string}>} rules
 * @returns {Array<{type: string, flagged: boolean, reason: string, weight: number, severity: string}>}
 */
function evaluateCustomRules(transaction, rules) {
  return (rules || [])
    .filter((rule) => evaluateOperator(rule.operator, transaction[rule.field], rule.value))
    .map((rule) => ({
      type: `custom_rule:${rule.rule_id}`,
      flagged: true,
      reason: `Custom rule "${rule.name}" matched (${rule.field} ${rule.operator} ${rule.value})`,
      weight: rule.weight,
      severity: rule.severity,
    }));
}

module.exports = { evaluateCustomRules, ALLOWED_FIELDS, ALLOWED_OPERATORS };
