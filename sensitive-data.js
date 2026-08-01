const REDACTION_MARKER = '[redacted]';
const PRIVATE_KEY_PATTERN = /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;
const PASSWORD_ASSIGNMENT_PATTERN = /(\b(?:password|passwd|pwd|client[ _-]?secret|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|auth[ _-]?token|bearer[ _-]?token)\b\s*(?::|=|\bis\b)\s*)(?!\[redacted\])(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;]+)/gi;
const SECRET_ASSIGNMENT_PATTERN = /(\b(?:secret|token)\b\s*(?::|=|\bis\b)\s*)(?!\[redacted\])(?:"[^"\r\n]{8,}"|'[^'\r\n]{8,}'|[A-Za-z0-9_~+/.:@=-]{8,})/gi;
const CREDENTIAL_ASSIGNMENT_PATTERN = /(\bcredential(?:s)?\b\s*(?::|=|\bis\b)\s*)(?!\[redacted\])(?:"[^"\r\n]*[:@][^"\r\n]+"|'[^'\r\n]*[:@][^'\r\n]+'|[A-Za-z0-9._-]{1,100}:[^\s,;]{4,})/gi;
const BEARER_TOKEN_PATTERN = /\bBearer[ \t]+([A-Za-z0-9._~+/=-]{8,})/gi;
const KNOWN_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|sk_live_[A-Za-z0-9]{16,})\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const EMAIL_PATTERN = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/gi;
const SSN_PATTERN = /(^|[^\d])(\d{3}[- ]\d{2}[- ]\d{4})(?!\d)/gm;
const PHONE_PATTERN = /(^|[^\d])((?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4})(?!\d)/gm;
const INTERNATIONAL_PHONE_PATTERN = /(^|[^\d])(\+\d[\d .()-]{8,20}\d)(?!\d)/gm;
const LABELED_PHONE_PATTERN = /(\b(?:phone|telephone|mobile|cell)\b\s*(?::|=|\bis\b)\s*)(?!\[redacted\])\+?[\d() .-]{7,22}/gi;
const PAYMENT_CARD_PATTERN = /\b(?:\d[ -]?){12,18}\d\b/g;
const SENSITIVE_QUERY_NAME = /^(?:access_?token|api_?key|auth(?:orization)?|client_?secret|credential(?:s)?|password|passwd|pwd|secret|sig(?:nature)?|token|x-amz-signature)$/i;
const TEXT_FIELDS = ['name', 'role', 'summary', 'location', 'workMode', 'availability'];
const LIST_FIELDS = ['universities', 'companies', 'skills', 'dateRanges'];

function redactSensitiveText(value) {
  let detected = false;
  let redacted = value;
  const replace = (pattern, replacement = REDACTION_MARKER) => {
    redacted = redacted.replace(pattern, (...matches) => {
      detected = true;
      return typeof replacement === 'function' ? replacement(...matches) : replacement;
    });
  };

  replace(PRIVATE_KEY_PATTERN);
  redacted = redacted.replace(URL_PATTERN, (url) => {
    if (!hasSensitiveUrlMaterial(url)) return url;
    detected = true;
    return REDACTION_MARKER;
  });
  replace(PASSWORD_ASSIGNMENT_PATTERN, (_match, prefix) => `${prefix}${REDACTION_MARKER}`);
  replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix) => `${prefix}${REDACTION_MARKER}`);
  replace(CREDENTIAL_ASSIGNMENT_PATTERN, (_match, prefix) => `${prefix}${REDACTION_MARKER}`);
  redacted = redacted.replace(BEARER_TOKEN_PATTERN, (match, token) => {
    if (token.length < 20 && !/[\d._~+/=-]/.test(token)) return match;
    detected = true;
    return REDACTION_MARKER;
  });
  replace(KNOWN_TOKEN_PATTERN);
  replace(JWT_PATTERN);
  replace(EMAIL_PATTERN);
  replace(SSN_PATTERN, (_match, prefix) => `${prefix}${REDACTION_MARKER}`);
  replace(PHONE_PATTERN, (_match, prefix) => `${prefix}${REDACTION_MARKER}`);
  redacted = redacted.replace(INTERNATIONAL_PHONE_PATTERN, (match, prefix, phone) => {
    const digitCount = phone.replace(/\D/g, '').length;
    if (digitCount < 10 || digitCount > 15) return match;
    detected = true;
    return `${prefix}${REDACTION_MARKER}`;
  });
  redacted = redacted.replace(LABELED_PHONE_PATTERN, (match, prefix) => {
    const digitCount = match.slice(prefix.length).replace(/\D/g, '').length;
    if (digitCount < 7 || digitCount > 15) return match;
    detected = true;
    return `${prefix}${REDACTION_MARKER}`;
  });
  redacted = redacted.replace(PAYMENT_CARD_PATTERN, (candidate) => {
    if (!isPaymentCardLike(candidate)) return candidate;
    detected = true;
    return REDACTION_MARKER;
  });

  return { value: redacted, detected };
}

function sanitizeCandidateDraft(draft) {
  let detected = false;
  const sanitized = { ...draft };

  for (const field of TEXT_FIELDS) {
    const result = redactSensitiveText(sanitized[field]);
    sanitized[field] = result.value;
    detected ||= result.detected;
  }
  for (const field of LIST_FIELDS) {
    sanitized[field] = sanitized[field].map((item) => {
      const result = redactSensitiveText(item);
      detected ||= result.detected;
      return result.value;
    });
  }

  return { draft: sanitized, detected };
}

function hasSensitiveUrlMaterial(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return true;
  if ([...parsed.searchParams.entries()].some(([name, queryValue]) => SENSITIVE_QUERY_NAME.test(name) && queryValue)) return true;
  if (!parsed.hash.includes('=')) return false;
  const fragment = new URLSearchParams(parsed.hash.slice(1));
  return [...fragment.entries()].some(([name, fragmentValue]) => SENSITIVE_QUERY_NAME.test(name) && fragmentValue);
}

function isPaymentCardLike(value) {
  const digits = value.replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19 || new Set(digits).size === 1) return false;

  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

export { REDACTION_MARKER, redactSensitiveText, sanitizeCandidateDraft };
