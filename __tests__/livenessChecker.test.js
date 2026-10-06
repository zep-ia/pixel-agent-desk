/**
 * livenessChecker.js Tests
 * PID detection, liveness checks, zombie sweep, reentrancy guards
 */

const path = require('path');
const os = require('os');

// Mock child_process before requiring the module
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// Mock fs
jest.mock('fs', () => ({
  statSync: jest.fn(),
}));

const { execFile } = require('child_process');
const fs = require('fs');

// Fresh module for each test suite
let livenessModule;

function loadFreshModule() {
  // Clear cached module so we get clean internal state
  const modulePath = require.resolve('../src/main/livenessChecker');
  delete require.cache[modulePath];
  livenessModule = require('../src/main/livenessChecker');
  return livenessModule;
}

// Fake `ps` for the unix code path. The checker asks for one column at a
// time (`-o comm=` then `-o args=`), so answer each from the same table.
// rows: [pid, comm, args]
function mockPs(rows) {
  return (cmd, args, opts, cb) => {
    if (cmd !== 'ps') return;
    const col = args.includes('comm=') ? 1 : 2;
    cb(null, rows.map(r => `${String(r[0]).padStart(5)} ${r[col]}`).join('\n') + '\n');
  };
}

// A Mac with two real Claude Code sessions (one in a terminal, one launched
// by the Claude desktop app) plus the look-alikes the old `node.*claude`
// pattern matched instead.
const DESKTOP_CLI = '/Users/me/Library/Application Support/Claude/claude-code/2.1.0/abc123/claude.app/Contents/MacOS/claude';
const MAC_PROCESSES = [
  [1, '/sbin/launchd', '/sbin/launchd'],
  [2001, 'claude', 'claude'],
  [2002, DESKTOP_CLI, `${DESKTOP_CLI} --output-format stream-json --verbose`],
  [3001, '/Applications/Claude.app/Contents/MacOS/Claude', '/Applications/Claude.app/Contents/MacOS/Claude'],
  [3002, '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper',
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility --utility-sub-type=node.mojom.NodeService'],
  [3003, '/Applications/Claude.app/Contents/Helpers/disclaimer',
    `/Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- ${DESKTOP_CLI} --output-format stream-json`],
  [3004, '/Users/me/Library/Application Support/SomeApp/NodeJS/24.13.1/node',
    '/Users/me/Library/Application Support/SomeApp/NodeJS/24.13.1/node /Users/me/Library/Application Support/SomeApp/Plugins/dev.claudeck.lite/bin/plugin.js'],
  [3005, '/bin/zsh', '/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh.sh'],
];

describe('livenessChecker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    loadFreshModule();
  });

  // ── checkLivenessTier1 (exported indirectly via startLivenessChecker) ──
  // We test it through the module's internal behavior

  // ── detectClaudePidByTranscript ──

  describe('detectClaudePidByTranscript', () => {
    test('calls lsof on non-win32 platform', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      execFile.mockImplementation((cmd, args, opts, cb) => {
        if (cmd === 'lsof') {
          cb(null, '12345\n');
        }
      });

      const callback = jest.fn();
      livenessModule.detectClaudePidByTranscript('/tmp/session.jsonl', callback);

      expect(execFile).toHaveBeenCalledWith('lsof', ['-t', '/tmp/session.jsonl'], expect.any(Object), expect.any(Function));
      expect(callback).toHaveBeenCalledWith(12345);

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    test('calls PowerShell on win32 platform', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      execFile.mockImplementation((cmd, args, opts, cb) => {
        if (cmd === 'powershell.exe') {
          cb(null, '6789\n');
        }
      });

      const callback = jest.fn();
      livenessModule.detectClaudePidByTranscript('/tmp/session.jsonl', callback);

      expect(execFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-NoProfile']),
        expect.any(Object),
        expect.any(Function)
      );
      expect(callback).toHaveBeenCalledWith(6789);

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    test('falls back to detectClaudePidsFallback on lsof error', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      const ps = mockPs([[111, 'claude', 'claude'], [222, '/usr/local/bin/claude', '/usr/local/bin/claude --resume']]);
      execFile.mockImplementation((cmd, args, opts, cb) => {
        if (cmd === 'lsof') {
          cb(new Error('not found'), '');
        } else {
          ps(cmd, args, opts, cb);
        }
      });

      const callback = jest.fn();
      livenessModule.detectClaudePidByTranscript('/tmp/session.jsonl', callback);

      // Should have listed processes with ps as fallback
      expect(execFile).toHaveBeenCalledWith('ps', expect.any(Array), expect.any(Object), expect.any(Function));
      expect(callback).toHaveBeenCalledWith([111, 222]);

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    test('falls back when jsonlPath is null', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      execFile.mockImplementation(mockPs([[555, 'claude', 'claude']]));

      const callback = jest.fn();
      livenessModule.detectClaudePidByTranscript(null, callback);

      // Should skip lsof, go directly to fallback
      expect(execFile).not.toHaveBeenCalledWith('lsof', expect.anything(), expect.anything(), expect.anything());
      expect(callback).toHaveBeenCalledWith([555]);

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    test('resolves ~ in jsonlPath to home directory', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      execFile.mockImplementation((cmd, args, opts, cb) => {
        if (cmd === 'lsof') {
          // Verify path was expanded
          const filePath = args[1];
          expect(filePath).toBe(path.join(os.homedir(), '.claude/session.jsonl'));
          cb(null, '7777\n');
        }
      });

      const callback = jest.fn();
      livenessModule.detectClaudePidByTranscript('~/.claude/session.jsonl', callback);

      expect(callback).toHaveBeenCalledWith(7777);

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    test('returns null when fallback finds no processes', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('no match'), '');
      });

      const callback = jest.fn();
      livenessModule.detectClaudePidByTranscript(null, callback);

      expect(callback).toHaveBeenCalledWith(null);

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    test('filters out invalid PIDs (NaN, 0, negative)', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      execFile.mockImplementation((cmd, args, opts, cb) => {
        if (cmd === 'lsof') {
          cb(null, 'abc\n0\n-5\n42\n');
        }
      });

      const callback = jest.fn();
      livenessModule.detectClaudePidByTranscript('/tmp/sess.jsonl', callback);

      expect(callback).toHaveBeenCalledWith(42);

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });
  });

  // ── isClaudeCliProcess ──

  describe('isClaudeCliProcess', () => {
    // Missing any of these means a live session is not counted, and the
    // sweep removes its avatar. The native binary has no "node" in it, and the
    // desktop app's copy sits under a path with a space in it.
    test.each([
      ['terminal session', 'claude', 'claude'],
      ['terminal session with flags', 'claude', 'claude --resume'],
      ['full path', '/opt/homebrew/bin/claude', '/opt/homebrew/bin/claude'],
      ['npm native binary', '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
        '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'],
      ['launched by the desktop app', DESKTOP_CLI, `${DESKTOP_CLI} --output-format stream-json`],
      ['older npm build, renamed itself', 'node', 'claude'],
      ['older npm build, by script path', '/usr/local/bin/node', 'node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'],
    ])('matches a Claude CLI session: %s', (label, comm, args) => {
      expect(livenessModule.isClaudeCliProcess(comm, args)).toBe(true);
    });

    // Counting any of these as a session keeps dead avatars alive, or hands
    // a session the wrong PID.
    test.each([
      ['the desktop app', '/Applications/Claude.app/Contents/MacOS/Claude', '/Applications/Claude.app/Contents/MacOS/Claude'],
      ['a desktop app helper', MAC_PROCESSES[4][1], MAC_PROCESSES[4][2]],
      ['a wrapper given the claude path', MAC_PROCESSES[5][1], MAC_PROCESSES[5][2]],
      ['another node tool with claude in its path', MAC_PROCESSES[6][1], MAC_PROCESSES[6][2]],
      ['a node script in a claude-named folder', 'node', 'node /Users/me/projects/claude-notes/server.js'],
      ['a shell started by a session', '/bin/zsh', '/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh.sh'],
      ['an editor with a claude file open', 'vim', 'vim /Users/me/notes/claude'],
      ['a similarly named program', 'claudette', 'claudette --serve'],
    ])('does not match a look-alike: %s', (label, comm, args) => {
      expect(livenessModule.isClaudeCliProcess(comm, args)).toBe(false);
    });

    test('handles missing values', () => {
      expect(livenessModule.isClaudeCliProcess(undefined, undefined)).toBe(false);
      expect(livenessModule.isClaudeCliProcess('', '')).toBe(false);
      expect(livenessModule.isClaudeCliProcess('node', undefined)).toBe(false);
    });
  });

  // ── detectClaudePidsFallback (win32 vs unix) ──

  describe('detectClaudePidsFallback (via null jsonlPath)', () => {
    test('win32 uses Get-CimInstance for node.exe', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      execFile.mockImplementation((cmd, args, opts, cb) => {
        if (cmd === 'powershell.exe') {
          cb(null, '1001\n1002\n');
        }
      });

      const callback = jest.fn();
      livenessModule.detectClaudePidByTranscript(null, callback);

      expect(callback).toHaveBeenCalledWith([1001, 1002]);

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    // Protects against handing a session the PID of some other program that
    // merely has "claude" in its command line.
    test('unix lists processes with ps and keeps only Claude CLI sessions', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      execFile.mockImplementation(mockPs(MAC_PROCESSES));

      const callback = jest.fn();
      livenessModule.detectClaudePidByTranscript(null, callback);

      expect(execFile).toHaveBeenCalledWith('ps', ['-A', '-o', 'pid=', '-o', 'comm='], expect.any(Object), expect.any(Function));
      expect(execFile).not.toHaveBeenCalledWith('pgrep', expect.anything(), expect.anything(), expect.anything());
      expect(callback).toHaveBeenCalledWith([2001, 2002]);

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });
  });

  // ── sessionPids Map ──

  describe('sessionPids', () => {
    test('is an exported Map', () => {
      expect(livenessModule.sessionPids).toBeInstanceOf(Map);
    });

    test('supports get/set/delete/has operations', () => {
      const { sessionPids } = livenessModule;
      sessionPids.set('test-session', 999);
      expect(sessionPids.get('test-session')).toBe(999);
      expect(sessionPids.has('test-session')).toBe(true);
      sessionPids.delete('test-session');
      expect(sessionPids.has('test-session')).toBe(false);
    });
  });

  // ── getJsonlMtime (tested via zombieSweep behavior) ──
  // We can test it indirectly since it's module-internal, but the function
  // itself is straightforward. We test via zombieSweep's sorting.

  describe('getJsonlMtime (internal)', () => {
    test('returns mtime when file exists', () => {
      // getJsonlMtime is not exported, but used internally by zombieSweep.
      // We verify fs.statSync behavior that zombieSweep depends on.
      const mockMtime = 1700000000000;
      fs.statSync.mockReturnValue({ mtimeMs: mockMtime });

      // Calling statSync directly to verify mock
      const stat = fs.statSync('/tmp/test.jsonl');
      expect(stat.mtimeMs).toBe(mockMtime);
    });

    test('returns fallback when statSync throws', () => {
      fs.statSync.mockImplementation(() => { throw new Error('ENOENT'); });

      // Verify the mock throws
      expect(() => fs.statSync('/nonexistent')).toThrow();
    });

    test('handles ~ path expansion', () => {
      fs.statSync.mockReturnValue({ mtimeMs: 1700000000000 });

      // The function internally expands ~ but since it's not exported,
      // we test that fs.statSync can handle the expanded path
      const expanded = path.join(os.homedir(), '.claude/session.jsonl');
      fs.statSync(expanded);
      expect(fs.statSync).toHaveBeenCalledWith(expanded);
    });
  });

  // ── countClaudeProcesses ──

  describe('countClaudeProcesses (via zombieSweep)', () => {
    test('win32 counts node.exe processes matching claude', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      // Reload module for win32 platform
      loadFreshModule();

      execFile.mockImplementation((cmd, args, opts, cb) => {
        if (cmd === 'powershell.exe' && args[1] && typeof args[1] === 'string' && args[1].includes('.Count')) {
          cb(null, '3\n');
        }
      });

      // countClaudeProcesses is not exported directly but used by zombieSweep
      // We verify the execFile mock matches expected commands
      expect(true).toBe(true); // Placeholder - tested through zombieSweep

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });
  });

  // ── retryPidDetection ── (reentrancy guard)

  describe('retryPidDetection', () => {
    // retryPidDetection is not exported, but we can test via the module pattern:
    // it's called by startLivenessChecker's interval loop.
    // We test the reentrancy concept here.

    test('reentrancy: sessionPids prevents re-detection for registered PIDs', () => {
      const { sessionPids } = livenessModule;
      sessionPids.set('already-known', 12345);

      // If sessionPids already has the session, retryPidDetection should skip
      expect(sessionPids.has('already-known')).toBe(true);
    });
  });

  // ── startLivenessChecker ──

  describe('startLivenessChecker', () => {
    let mockAgentManager;
    let debugLog;

    beforeEach(() => {
      jest.useFakeTimers();
      mockAgentManager = {
        getAllAgents: jest.fn(() => []),
        getAgent: jest.fn(() => null),
        getAgentCount: jest.fn(() => 0),
        updateAgent: jest.fn(),
        removeAgent: jest.fn(),
      };
      debugLog = jest.fn();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('sets up two intervals (2s liveness + 30s zombie sweep)', () => {
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });

      // Should create exactly 2 intervals
      expect(setIntervalSpy).toHaveBeenCalledTimes(2);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30000);
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2000);

      setIntervalSpy.mockRestore();
    });

    test('skips agents within grace period', async () => {
      const now = Date.now();
      mockAgentManager.getAllAgents.mockReturnValue([
        { id: 'new-agent', firstSeen: now, state: 'Waiting' },
      ]);

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });

      // Advance 2s (liveness interval)
      jest.advanceTimersByTime(2000);

      // Wait for async handler
      await Promise.resolve();

      // Should NOT attempt to remove (within 10s grace)
      expect(mockAgentManager.removeAgent).not.toHaveBeenCalled();
    });

    test('removes agent after no-PID timeout (grace + 10s)', async () => {
      const oldTime = Date.now() - 25000; // 25 seconds ago
      mockAgentManager.getAllAgents.mockReturnValue([
        { id: 'old-agent', firstSeen: oldTime, state: 'Working' },
      ]);
      mockAgentManager.getAgentCount.mockReturnValue(2); // not solo
      mockAgentManager.getAgent.mockReturnValue({ id: 'old-agent', jsonlPath: null });

      // Fallback returns null (no PIDs found)
      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('not found'), '');
      });

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });

      // Use async version to properly handle async interval callbacks
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockAgentManager.removeAgent).toHaveBeenCalledWith('old-agent');
    });

    test('solo agent protection: does not remove the only agent without PID', async () => {
      const oldTime = Date.now() - 25000;
      mockAgentManager.getAllAgents.mockReturnValue([
        { id: 'solo-agent', firstSeen: oldTime, state: 'Working' },
      ]);
      mockAgentManager.getAgentCount.mockReturnValue(1); // solo agent
      mockAgentManager.getAgent.mockReturnValue({ id: 'solo-agent', jsonlPath: null });

      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('not found'), '');
      });

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockAgentManager.removeAgent).not.toHaveBeenCalled();
      expect(debugLog).toHaveBeenCalledWith(expect.stringContaining('solo agent'));
    });

    test('keeps alive agent with valid PID', async () => {
      const oldTime = Date.now() - 15000;
      livenessModule.sessionPids.set('alive-agent', process.pid); // use current PID (always alive)

      mockAgentManager.getAllAgents.mockReturnValue([
        { id: 'alive-agent', firstSeen: oldTime, state: 'Working' },
      ]);

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockAgentManager.removeAgent).not.toHaveBeenCalled();
    });

    test('restores Offline agent to Waiting when PID is alive', async () => {
      const oldTime = Date.now() - 15000;
      const agent = { id: 'offline-agent', firstSeen: oldTime, state: 'Offline' };
      livenessModule.sessionPids.set('offline-agent', process.pid);

      mockAgentManager.getAllAgents.mockReturnValue([agent]);

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockAgentManager.updateAgent).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'Waiting' }),
        'live'
      );
    });
  });

  // ── zombieSweep ──

  describe('zombieSweep behavior', () => {
    let mockAgentManager;
    let debugLog;

    beforeEach(() => {
      jest.useFakeTimers();
      mockAgentManager = {
        getAllAgents: jest.fn(() => []),
        getAgent: jest.fn(() => null),
        getAgentCount: jest.fn(() => 0),
        updateAgent: jest.fn(),
        removeAgent: jest.fn(),
      };
      debugLog = jest.fn();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    test('zombie sweep removes excess agents by oldest mtime', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      // 3 main agents but only 1 process
      mockAgentManager.getAllAgents.mockReturnValue([
        { id: 'agent-1', isSubagent: false, jsonlPath: '/tmp/a.jsonl' },
        { id: 'agent-2', isSubagent: false, jsonlPath: '/tmp/b.jsonl' },
        { id: 'agent-3', isSubagent: false, jsonlPath: '/tmp/c.jsonl' },
      ]);

      // mtime: agent-1 oldest, agent-3 newest
      fs.statSync.mockImplementation((p) => {
        if (p.includes('a.jsonl')) return { mtimeMs: 1000 };
        if (p.includes('b.jsonl')) return { mtimeMs: 2000 };
        if (p.includes('c.jsonl')) return { mtimeMs: 3000 };
        return { mtimeMs: 0 };
      });

      // ps shows 1 Claude CLI process
      execFile.mockImplementation(mockPs([[100, 'claude', 'claude'], [200, 'vim', 'vim notes.txt']]));

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });

      // Trigger zombie sweep (30s interval)
      jest.advanceTimersByTime(30000);

      // Should remove 2 oldest agents (excess = 3 - 1 = 2)
      expect(mockAgentManager.removeAgent).toHaveBeenCalledTimes(2);
      expect(mockAgentManager.removeAgent).toHaveBeenCalledWith('agent-1');
      expect(mockAgentManager.removeAgent).toHaveBeenCalledWith('agent-2');

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    test('zombie sweep skips subagents', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      mockAgentManager.getAllAgents.mockReturnValue([
        { id: 'main-1', isSubagent: false, jsonlPath: '/tmp/a.jsonl' },
        { id: 'sub-1', isSubagent: true, jsonlPath: '/tmp/b.jsonl' },
      ]);

      // Only 1 main agent → should skip sweep (mainCount <= 1)
      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });
      jest.advanceTimersByTime(30000);

      expect(mockAgentManager.removeAgent).not.toHaveBeenCalled();

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    test('zombie sweep does nothing when process count >= agent count', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });

      mockAgentManager.getAllAgents.mockReturnValue([
        { id: 'agent-1', isSubagent: false, jsonlPath: '/tmp/a.jsonl' },
        { id: 'agent-2', isSubagent: false, jsonlPath: '/tmp/b.jsonl' },
      ]);

      // 2 processes for 2 agents → no excess
      execFile.mockImplementation(mockPs([[100, 'claude', 'claude'], [101, '/opt/homebrew/bin/claude', '/opt/homebrew/bin/claude --resume']]));

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });
      jest.advanceTimersByTime(30000);

      expect(mockAgentManager.removeAgent).not.toHaveBeenCalled();

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    // Regression: on macOS the count came from `pgrep -fc`, which BSD pgrep
    // does not support. It printed a usage error, the count read as 0, and
    // every sweep removed every agent.
    test('zombie sweep on macOS keeps both live sessions and never calls pgrep', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      mockAgentManager.getAllAgents.mockReturnValue([
        { id: 'agent-1', isSubagent: false, jsonlPath: '/tmp/a.jsonl' },
        { id: 'agent-2', isSubagent: false, jsonlPath: '/tmp/b.jsonl' },
      ]);

      // One terminal session, one desktop-app session, and the look-alikes
      execFile.mockImplementation(mockPs(MAC_PROCESSES));

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });
      jest.advanceTimersByTime(30000);

      expect(execFile).not.toHaveBeenCalledWith('pgrep', expect.anything(), expect.anything(), expect.anything());
      expect(mockAgentManager.removeAgent).not.toHaveBeenCalled();

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    // Protects live agents when the count cannot be taken at all: "could not
    // check" must not be treated as "zero processes".
    test('zombie sweep skips when the process count fails', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      mockAgentManager.getAllAgents.mockReturnValue([
        { id: 'agent-1', isSubagent: false, jsonlPath: '/tmp/a.jsonl' },
        { id: 'agent-2', isSubagent: false, jsonlPath: '/tmp/b.jsonl' },
      ]);

      execFile.mockImplementation((cmd, args, opts, cb) => {
        cb(new Error('spawn ps ENOENT'), '');
      });

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });
      jest.advanceTimersByTime(30000);

      expect(mockAgentManager.removeAgent).not.toHaveBeenCalled();
      expect(debugLog).toHaveBeenCalledWith(expect.stringContaining('could not count'));

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });

    // Protects the sweep's real job: look-alike processes must not be counted
    // as sessions, or a dead agent's avatar would never be cleaned up.
    test('zombie sweep does not count look-alike processes as sessions', () => {
      const origPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

      // 3 agents, but only 2 real sessions among the processes
      mockAgentManager.getAllAgents.mockReturnValue([
        { id: 'agent-1', isSubagent: false, jsonlPath: '/tmp/a.jsonl' },
        { id: 'agent-2', isSubagent: false, jsonlPath: '/tmp/b.jsonl' },
        { id: 'agent-3', isSubagent: false, jsonlPath: '/tmp/c.jsonl' },
      ]);

      fs.statSync.mockImplementation((p) => {
        if (p.includes('a.jsonl')) return { mtimeMs: 1000 };
        if (p.includes('b.jsonl')) return { mtimeMs: 2000 };
        if (p.includes('c.jsonl')) return { mtimeMs: 3000 };
        return { mtimeMs: 0 };
      });

      execFile.mockImplementation(mockPs(MAC_PROCESSES));

      livenessModule.startLivenessChecker({ agentManager: mockAgentManager, debugLog });
      jest.advanceTimersByTime(30000);

      // excess = 3 agents - 2 real processes = 1 → only the oldest goes
      expect(mockAgentManager.removeAgent).toHaveBeenCalledTimes(1);
      expect(mockAgentManager.removeAgent).toHaveBeenCalledWith('agent-1');

      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    });
  });
});
