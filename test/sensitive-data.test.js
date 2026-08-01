import { describe, expect, test } from 'bun:test';
import { REDACTION_MARKER, redactSensitiveText } from '../sensitive-data.js';

describe('sensitive text policy', () => {
  test('redacts high-confidence contact, identity, payment, credential, token, key, and URL secrets', () => {
    const sensitiveValues = [
      'ada.candidate+hn@example.com',
      '+1 (415) 555-2671',
      '+44 20 7946 0958',
      'Phone: 4155552671',
      '123-45-6789',
      '4111 1111 1111 1111',
      'Password: correct-horse-battery-staple',
      'client_secret=client-secret-value',
      'credential: admin:private-password',
      'Authorization: Bearer bearer-token-value',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2',
      'https://user:private-password@example.com/profile',
      'https://portfolio.example/profile?access_token=query-secret-value',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-material\n-----END OPENSSH PRIVATE KEY-----'
    ];

    for (const sensitiveValue of sensitiveValues) {
      const result = redactSensitiveText(`before ${sensitiveValue} after`);
      expect(result.detected).toBe(true);
      expect(result.value).toContain(REDACTION_MARKER);
      expect(result.value).not.toContain(sensitiveValue);
    }
  });

  test('redacts a private-key block even when extraction truncates it before its END marker', () => {
    const truncatedKey = `Summary: -----BEGIN PRIVATE KEY-----\n${'a'.repeat(2_000)}`.slice(0, 1_500);
    const result = redactSensitiveText(truncatedKey);

    expect(result).toEqual({ value: `Summary: ${REDACTION_MARKER}`, detected: true });
    expect(result.value).not.toContain('a'.repeat(20));
  });

  test('preserves legitimate professional data and clean URLs byte-for-byte', () => {
    const professionalProfile = [
      'Ada Lovelace | Staff Engineer at 37signals',
      'MIT, University of Waterloo, Toronto, Canada',
      'C++, Go 1.22.3, ISO 27001, SOC 2, postal code 02139',
      'Experience: 2021 - 2024',
      'Credentials: AWS Certified Solutions Architect',
      'Credentials: Kubernetes',
      'Credential: Terraform Associate',
      'Secret Manager and bearer authentication',
      'Card test boundary: 4111 1111 1111 1112',
      'https://github.com/ada?tab=repositories',
      'https://www.linkedin.com/in/ada-lovelace',
      'https://ada.dev/portfolio?ref=hn'
    ].join('\n');

    expect(redactSensitiveText(professionalProfile)).toEqual({ value: professionalProfile, detected: false });
  });

  test('is semantically idempotent after visible redaction', () => {
    const first = redactSensitiveText('Password: secret-value\nContact: ada@example.com\nPhone: 4155552671');
    const second = redactSensitiveText(first.value);

    expect(first.detected).toBe(true);
    expect(second).toEqual({ value: first.value, detected: false });
  });
});
