import { describe, expect, it } from 'bun:test';

import { matchBridgeCommand } from '@/bridge/router';

describe('bridge command router', () => {
  it('routes session status phrasings', () => {
    expect(matchBridgeCommand('status of my sessions')).toBe('sessions_status');
    expect(matchBridgeCommand('Jarvis, session status')).toBe('sessions_status');
    expect(matchBridgeCommand('list my sessions')).toBe('sessions_status');
    expect(matchBridgeCommand('how are my sessions?')).toBe('sessions_status');
    expect(matchBridgeCommand('estado de mis sesiones')).toBe('sessions_status');
  });

  it('routes ledger phrasings', () => {
    expect(matchBridgeCommand('show the quorum ledger')).toBe('ledger_tail');
    expect(matchBridgeCommand('ledger')).toBe('ledger_tail');
    expect(matchBridgeCommand('read me the hub ledger')).toBe('ledger_tail');
  });

  it('leaves conversation alone', () => {
    expect(matchBridgeCommand('what is the capital of Finland?')).toBeNull();
    expect(
      matchBridgeCommand('tell me about session musicians in the seventies'),
    ).toBeNull();
    expect(matchBridgeCommand('what is a session?')).toBeNull();
    expect(matchBridgeCommand('set a timer for five minutes')).toBeNull();
    expect(matchBridgeCommand('')).toBeNull();
  });

  it('rejects long utterances even with keywords', () => {
    expect(
      matchBridgeCommand(
        'so I was wondering if maybe you could possibly check the general status of all of the running sessions later tonight',
      ),
    ).toBeNull();
  });
});
