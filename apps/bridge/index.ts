// Jarvis Mac bridge daemon: holds an outbound WebSocket to the Apollo agent
// and executes a FIXED table of read-only commands on behalf of voice
// requests. Nothing from the wire ever reaches a shell: the command name is
// looked up in the table below and unknown names return an error result.
//
// Run under launchd (see com.jarvis.bridge.plist). The bridge token lives in
// the macOS Keychain: security add-generic-password -s jarvis-bridge -a apollo -w <token>

const AGENT_URL = 'wss://apollo.ygdcbtmc4u.workers.dev/agents/apollo/desk';
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;
const COMMAND_TIMEOUT_MS = 8_000;

async function readBridgeTokenFromKeychain(): Promise<string> {
  const proc = Bun.spawn(
    ['security', 'find-generic-password', '-s', 'jarvis-bridge', '-a', 'apollo', '-w'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const output = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0 || output.trim().length === 0) {
    throw new Error('bridge token not found in Keychain (service jarvis-bridge)');
  }
  return output.trim();
}

async function runFixedCommand(argv: readonly string[]): Promise<string> {
  const proc = Bun.spawn([...argv], { stdout: 'pipe', stderr: 'pipe' });
  const killTimer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS);
  const output = await new Response(proc.stdout).text();
  clearTimeout(killTimer);
  return output;
}

function summarizeSessions(rawOutput: string): string {
  // orca terminal list: session lines start with "term_"; preview lines are
  // TUI noise and never speakable.
  const sessionLineList = rawOutput
    .split('\n')
    .filter((line) => line.startsWith('term_'));
  if (sessionLineList.length === 0) {
    return 'There are no active sessions on your Mac right now.';
  }
  const describedList = sessionLineList.slice(0, 6).map((line) => {
    const columnList = line.split(/\s{2,}/);
    const title = (columnList[1] ?? 'untitled').replace(/^[^A-Za-z0-9]+/, '').trim();
    const state = columnList[2] ?? '';
    return state.length > 0 ? `${title} (${state})` : title;
  });
  const overflowNote =
    sessionLineList.length > 6 ? `, and ${sessionLineList.length - 6} more` : '';
  return `You have ${sessionLineList.length} active session${
    sessionLineList.length === 1 ? '' : 's'
  }: ${describedList.join('; ')}${overflowNote}.`;
}

function summarizeLedger(rawOutput: string): string {
  const rowList = rawOutput
    .split('\n')
    .filter(
      (line) =>
        line.startsWith('|') && !line.includes('---') && !line.includes('| date |'),
    );
  if (rowList.length === 0) {
    return 'The quorum ledger is empty.';
  }
  const describedList = rowList.slice(-3).map((row) => {
    const cellList = row.split('|').map((cell) => cell.trim());
    const [, , slug, className, , status, winner] = cellList;
    const winnerNote = winner && winner.length > 0 ? `, winner ${winner}` : '';
    return `${slug ?? 'unknown'} (${className ?? ''}, ${status ?? ''}${winnerNote})`;
  });
  return `Latest quorum sittings: ${describedList.join('; ')}.`;
}

const COMMAND_TABLE: Record<
  string,
  { readonly argv: readonly string[]; readonly summarize: (output: string) => string }
> = {
  sessions_status: {
    argv: ['/usr/local/bin/orca', 'terminal', 'list'],
    summarize: summarizeSessions,
  },
  ledger_tail: {
    argv: [`${process.env.HOME}/.local/bin/hub`, 'log'],
    summarize: summarizeLedger,
  },
};

let reconnectDelayMs = RECONNECT_MIN_MS;

async function connectOnce(token: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`${AGENT_URL}?token=${token}`);

    ws.addEventListener('open', () => {
      reconnectDelayMs = RECONNECT_MIN_MS;
      console.log(`[bridge] connected ${new Date().toISOString()}`);
    });

    ws.addEventListener('message', async (event) => {
      if (typeof event.data !== 'string') {
        return;
      }
      let frame: { type?: string; id?: string; command?: string };
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.type !== 'bridge_command' || typeof frame.id !== 'string') {
        return;
      }
      const commandEntry =
        typeof frame.command === 'string' ? COMMAND_TABLE[frame.command] : undefined;
      if (commandEntry === undefined) {
        ws.send(
          JSON.stringify({
            type: 'bridge_result',
            id: frame.id,
            ok: false,
            output: 'unknown bridge command',
          }),
        );
        return;
      }
      try {
        const rawOutput = await runFixedCommand(commandEntry.argv);
        ws.send(
          JSON.stringify({
            type: 'bridge_result',
            id: frame.id,
            ok: true,
            output: commandEntry.summarize(rawOutput),
          }),
        );
        console.log(`[bridge] ran ${frame.command}`);
      } catch (error) {
        ws.send(
          JSON.stringify({
            type: 'bridge_result',
            id: frame.id,
            ok: false,
            output: `command failed: ${error instanceof Error ? error.message : 'unknown'}`,
          }),
        );
      }
    });

    ws.addEventListener('close', () => {
      console.log(`[bridge] disconnected; retrying in ${reconnectDelayMs}ms`);
      resolve();
    });
    ws.addEventListener('error', () => {
      // the close event follows and drives the retry.
    });
  });
}

const bridgeToken = await readBridgeTokenFromKeychain();
for (;;) {
  await connectOnce(bridgeToken);
  await new Promise((resolveSleep) => setTimeout(resolveSleep, reconnectDelayMs));
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_MAX_MS);
}
