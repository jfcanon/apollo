// Mode-A intent routing: voice commands that target the owner's Mac (AI
// session management) instead of the LLM. The decision is an exact keyword
// grammar on the transcript — deliberately never an LLM call: a spoken
// transcript is untrusted input, and a model must not be the thing that
// decides whether a request gains access to the machine bridge.

export type BridgeCommandName = 'sessions_status' | 'ledger_tail';

const SESSION_WORD = /\b(sessions?|sesion(?:es)?)\b/;
const LEDGER_WORD = /\bledger\b/;

// Verbs/framings that make the sentence a status request rather than an
// utterance that merely mentions the word (e.g. "what is a session?").
const STATUS_FRAME =
  /\b(status|state|estado|list|lista|show|check|how (?:are|is)|what(?:'s| is) (?:up|happening|the status)|como (?:estan|va|andan))\b/;

function normalizeTranscript(rawTranscript: string): string {
  return rawTranscript
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/[̀-ͯ]/g, '')
    .replaceAll(/[^a-z0-9\s']/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

export function matchBridgeCommand(rawTranscript: string): BridgeCommandName | null {
  const transcript = normalizeTranscript(rawTranscript);
  if (transcript.length === 0 || transcript.split(' ').length > 12) {
    // Long utterances are conversation, not commands; only short imperative
    // phrases route to the bridge.
    return null;
  }
  if (LEDGER_WORD.test(transcript)) {
    return 'ledger_tail';
  }
  if (SESSION_WORD.test(transcript) && STATUS_FRAME.test(transcript)) {
    return 'sessions_status';
  }
  return null;
}
