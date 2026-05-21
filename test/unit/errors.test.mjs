import { describe, it, expect } from 'vitest';
import { ERROR_CODES, makeError, EXIT_CODES } from '../../scripts/lib/errors.mjs';

/** @typedef {import("../../scripts/lib/types.d.ts").ErrorCode} ErrorCode */

describe('errors', () => {
  it('exposes the full master-design §14 taxonomy as ERROR_CODES', () => {
    /** @type {ErrorCode[]} */
    const required = [
      'auth_failed',
      'not_installed',
      'stall',
      'total_timeout',
      'rate_limited',
      'network',
      'tool_refused',
      'cancelled',
      'parse_error',
      'session_invalid',
      'worktree_failed',
      'dirty_tree',
      'internal',
    ];
    for (const code of required) {
      expect(ERROR_CODES).toHaveProperty(code);
      expect(ERROR_CODES[code]).toBe(code); // codes are their own values
    }
  });

  it('makeError builds a structured error object', () => {
    const err = makeError('stall', 'silence watchdog fired after 120s', { model: 'gpt-5.4' });
    expect(err).toEqual({
      code: 'stall',
      message: 'silence watchdog fired after 120s',
      details: { model: 'gpt-5.4' },
    });
  });

  it('makeError omits details when not provided', () => {
    const err = makeError('auth_failed', 'no api key');
    expect(err).toEqual({ code: 'auth_failed', message: 'no api key' });
    expect(err).not.toHaveProperty('details');
  });

  it('makeError throws on unknown code', () => {
    expect(() => makeError(/** @type {ErrorCode} */ ('not_a_real_code'), 'x')).toThrow(/unknown error code/);
  });

  it('exposes EXIT_CODES per master design §7.4', () => {
    expect(EXIT_CODES).toEqual({
      SUCCESS: 0,
      ALL_RUNS_FAILED: 1,
      CONFIG_ERROR: 2,
      AUTH_FAILURE: 3,
      NOT_INSTALLED: 4,
      JOB_STILL_RUNNING: 5,
      UNKNOWN_JOB: 6,
    });
  });
});
