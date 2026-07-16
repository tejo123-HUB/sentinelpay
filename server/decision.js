// 3-tier decision layer: turns a 0-100 fraud score into allow / step_up / block.
const BLOCK_THRESHOLD = 80; // score strictly above this -> block
const STEP_UP_THRESHOLD = 40; // score at or above this (and at/below BLOCK_THRESHOLD) -> step_up; below -> allow

/**
 * @param {number} score - 0-100 fraud score from scoring.js
 * @returns {'allow'|'step_up'|'block'}
 */
function decide(score) {
  if (score > BLOCK_THRESHOLD) return 'block';
  if (score >= STEP_UP_THRESHOLD) return 'step_up';
  return 'allow';
}

decide.BLOCK_THRESHOLD = BLOCK_THRESHOLD;
decide.STEP_UP_THRESHOLD = STEP_UP_THRESHOLD;

module.exports = decide;
