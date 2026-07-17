const VALID_TRANSACTION_TYPES = ['transfer', 'withdrawal', 'deposit'];
const MAX_ID_LENGTH = 128; // sender_id/receiver_id/device_id/merchant_id — generous but bounded
const MAX_PURPOSE_LENGTH = 256; // freeform note text, longer than an id but still bounded
// Sanity cap, not a business rule: `amount` was previously only checked for > 0 and finite, so a
// pathological value (e.g. 1e300) would pass through untouched into avg_transaction_amount and
// every dashboard total. Set far above any plausible micro-transaction (architecture.md's own
// examples top out around ₹80,000 for a whole structuring burst) so it never interferes with
// real traffic, single-transaction or structuring.
const MAX_AMOUNT = 10_000_000;
const MAX_COUNTRY_LENGTH = 8; // ISO 3166-1 alpha-2/alpha-3 codes fit comfortably; generous bound, not a strict enum

/**
 * Validates and normalizes a POST /transaction request body.
 * @returns {{ valid: true, value: object } | { valid: false, error: string }}
 */
function validateTransactionInput(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'Request body must be a JSON object' };
  }

  const {
    sender_id,
    receiver_id,
    amount,
    timestamp,
    location,
    device_id,
    merchant_id,
    purpose,
    transaction_type,
    reference_transaction_id,
    employee_id,
    country,
    ip_address,
  } = body;

  if (typeof sender_id !== 'string' || sender_id.trim() === '' || sender_id.length > MAX_ID_LENGTH) {
    return { valid: false, error: `sender_id is required and must be a non-empty string of at most ${MAX_ID_LENGTH} characters` };
  }
  if (typeof receiver_id !== 'string' || receiver_id.trim() === '' || receiver_id.length > MAX_ID_LENGTH) {
    return { valid: false, error: `receiver_id is required and must be a non-empty string of at most ${MAX_ID_LENGTH} characters` };
  }
  if (sender_id === receiver_id) {
    return { valid: false, error: 'sender_id and receiver_id must be different' };
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    return { valid: false, error: `amount is required and must be a positive number, at most ${MAX_AMOUNT}` };
  }
  if (typeof timestamp !== 'string' || Number.isNaN(new Date(timestamp).getTime())) {
    return { valid: false, error: 'timestamp is required and must be a valid ISO 8601 date string' };
  }
  if (!VALID_TRANSACTION_TYPES.includes(transaction_type)) {
    return {
      valid: false,
      error: `transaction_type is required and must be one of: ${VALID_TRANSACTION_TYPES.join(', ')}`,
    };
  }

  let normalizedLocation = null;
  if (location !== undefined && location !== null) {
    if (
      typeof location !== 'object' ||
      typeof location.lat !== 'number' ||
      typeof location.lng !== 'number' ||
      !Number.isFinite(location.lat) ||
      !Number.isFinite(location.lng) ||
      location.lat < -90 ||
      location.lat > 90 ||
      location.lng < -180 ||
      location.lng > 180
    ) {
      return {
        valid: false,
        error: 'location, if provided, must be an object with numeric lat in [-90,90] and lng in [-180,180]',
      };
    }
    normalizedLocation = { lat: location.lat, lng: location.lng };
  }

  if (typeof device_id === 'string' && device_id.length > MAX_ID_LENGTH) {
    return { valid: false, error: `device_id must be at most ${MAX_ID_LENGTH} characters` };
  }
  if (typeof merchant_id === 'string' && merchant_id.length > MAX_ID_LENGTH) {
    return { valid: false, error: `merchant_id must be at most ${MAX_ID_LENGTH} characters` };
  }
  if (typeof purpose === 'string' && purpose.length > MAX_PURPOSE_LENGTH) {
    return { valid: false, error: `purpose must be at most ${MAX_PURPOSE_LENGTH} characters` };
  }
  if (typeof reference_transaction_id === 'string' && reference_transaction_id.length > MAX_ID_LENGTH) {
    return { valid: false, error: `reference_transaction_id must be at most ${MAX_ID_LENGTH} characters` };
  }
  if (typeof employee_id === 'string' && employee_id.length > MAX_ID_LENGTH) {
    return { valid: false, error: `employee_id must be at most ${MAX_ID_LENGTH} characters` };
  }
  if (typeof country === 'string' && country.length > MAX_COUNTRY_LENGTH) {
    return { valid: false, error: `country must be at most ${MAX_COUNTRY_LENGTH} characters` };
  }
  if (typeof ip_address === 'string' && ip_address.length > MAX_ID_LENGTH) {
    return { valid: false, error: `ip_address must be at most ${MAX_ID_LENGTH} characters` };
  }

  return {
    valid: true,
    value: {
      sender_id,
      receiver_id,
      amount,
      timestamp: new Date(timestamp).toISOString(),
      location: normalizedLocation,
      device_id: typeof device_id === 'string' ? device_id : null,
      merchant_id: typeof merchant_id === 'string' ? merchant_id : null,
      purpose: typeof purpose === 'string' ? purpose : null,
      transaction_type,
      reference_transaction_id: typeof reference_transaction_id === 'string' ? reference_transaction_id : null,
      employee_id: typeof employee_id === 'string' ? employee_id : null,
      country: typeof country === 'string' ? country : null,
      ip_address: typeof ip_address === 'string' ? ip_address : null,
    },
  };
}

module.exports = { validateTransactionInput, VALID_TRANSACTION_TYPES, MAX_AMOUNT, MAX_PURPOSE_LENGTH, MAX_ID_LENGTH, MAX_COUNTRY_LENGTH };
