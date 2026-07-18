// Section 15.16, Feature 10: flags an employee issuing an excessive number of refunds, or
// repeatedly refunding the same receiver -- an internal-fraud pattern (an employee routing
// refunds to their own or an accomplice's account) distinct from every other detector in this
// extension, which all judge the business account's behavior, not an individual staff member's.
// Only meaningful when the caller supplies employee_id -- most transactions won't.
const { EMPLOYEE_FRAUD } = require('../config');

const EMPLOYEE_EXCESSIVE_REFUNDS_WEIGHT = 40; // contribution to the 0-100 fraud score when flagged
const EMPLOYEE_SAME_RECEIVER_WEIGHT = 55; // stronger signal -- routing refunds to one specific receiver repeatedly looks deliberate, not just a busy shift

/**
 * @param {{ purpose: string|null, employee_id: string|null }} transaction
 * @param {{ employeeRefundCount: number, employeeRefundCountToReceiver: number }} outboundContext
 */
function employeeFraud(transaction, outboundContext) {
  const purpose = (transaction.purpose || '').toLowerCase();
  if (!purpose.includes('refund') || !transaction.employee_id) {
    return { flagged: false, reason: null, weight: 0, severity: null };
  }

  const priorCountToReceiver = (outboundContext && outboundContext.employeeRefundCountToReceiver) || 0;
  if (priorCountToReceiver + 1 >= EMPLOYEE_FRAUD.EMPLOYEE_SAME_RECEIVER_THRESHOLD) {
    return {
      flagged: true,
      reason: `Employee ${transaction.employee_id} has repeatedly issued refunds to the same receiver`,
      weight: EMPLOYEE_SAME_RECEIVER_WEIGHT,
      severity: 'High',
    };
  }

  const priorCount = (outboundContext && outboundContext.employeeRefundCount) || 0;
  if (priorCount + 1 >= EMPLOYEE_FRAUD.EMPLOYEE_REFUND_COUNT_THRESHOLD) {
    return {
      flagged: true,
      reason: `Employee ${transaction.employee_id} has issued an unusually high number of refunds`,
      weight: EMPLOYEE_EXCESSIVE_REFUNDS_WEIGHT,
      severity: 'Medium',
    };
  }

  return { flagged: false, reason: null, weight: 0, severity: null };
}

employeeFraud.EMPLOYEE_EXCESSIVE_REFUNDS_WEIGHT = EMPLOYEE_EXCESSIVE_REFUNDS_WEIGHT;
employeeFraud.EMPLOYEE_SAME_RECEIVER_WEIGHT = EMPLOYEE_SAME_RECEIVER_WEIGHT;

module.exports = employeeFraud;
