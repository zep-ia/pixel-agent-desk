/**
 * Liveness Checker
 * PID detection, transcript-based re-verification, 2-second interval process liveness check
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const sessionPids = new Map(); // sessionId → actual claude process PID

async function checkLivenessTier1(agentId, pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Function to accurately find the Claude PID for a session using transcript_path
 * Linux/macOS: lsof -t <path>
 * Windows: Restart Manager API (find-file-owner.ps1)
 */
function detectClaudePidByTranscript(jsonlPath, callback) {
  const { execFile } = require('child_process');

  if (!jsonlPath) {
    detectClaudePidsFallback(callback);
    return;
  }

  const resolved = jsonlPath.startsWith('~')
    ? path.join(os.homedir(), jsonlPath.slice(1))
    : jsonlPath;

  if (process.platform === 'win32') {
    const scriptPath = path.join(__dirname, '..', 'find-file-owner.ps1');
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-FilePath', resolved],
      { timeout: 5000 }, (err, stdout) => {
      if (!err && stdout) {
        const pids = stdout.trim().split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p > 0);
        if (pids.length > 0) {
          return callback(pids[0]);
        }
      }
      detectClaudePidsFallback(callback);
    });
  } else {
    execFile('lsof', ['-t', resolved], { timeout: 3000 }, (err, stdout) => {
      if (!err && stdout) {
        const pids = stdout.trim().split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p > 0);
        if (pids.length > 0) {
          return callback(pids[0]);
        }
      }
      detectClaudePidsFallback(callback);
    });
  }
}

function detectClaudePidsFallback(callback) {
  const { execFile } = require('child_process');
  if (process.platform === 'win32') {
    // Search only node.exe (exclude Claude Desktop App's claude.exe)
    const psCmd = `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*claude*' } | Select-Object -ExpandProperty ProcessId`;
    execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 6000 }, (err, stdout) => {
      if (err || !stdout) return callback(null);
      const pids = stdout.trim().split('\n').map(p => parseInt(p.trim(), 10)).filter(p => !isNaN(p) && p > 0);
      callback(pids.length > 0 ? pids : null);
    });
  } else {
    // Exclude Claude desktop app (Claude.app) and its helpers, otherwise focus opens Claude instead of the terminal
    execFile('ps', ['-axo', 'pid=,command='], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return callback(null);
      const pids = stdout.split('\n')
        .map(l => l.trim().match(/^(\d+)\s+(.*)$/))
        .filter(m => m && /(^|\/)claude(\s|$)|node.*claude/.test(m[2]) && !/\.app\//.test(m[2]) && !/pixel-agent-desk/.test(m[2]))
        .map(m => parseInt(m[1], 10))
        .filter(p => p > 0 && p !== process.pid);
      callback(pids.length > 0 ? pids : null);
    });
  }
}

// Re-detect agents with unregistered PIDs (prevent duplicate execution)
const _pidRetryRunning = new Set();
function retryPidDetection(sessionId, agentManager, debugLog) {
  if (_pidRetryRunning.has(sessionId) || sessionPids.has(sessionId)) return;
  _pidRetryRunning.add(sessionId);

  const agent = agentManager ? agentManager.getAgent(sessionId) : null;
  const jsonlPath = agent ? agent.jsonlPath : null;

  detectClaudePidByTranscript(jsonlPath, (result) => {
    _pidRetryRunning.delete(sessionId);
    if (!result) return;

    if (typeof result === 'number') {
      sessionPids.set(sessionId, result);
      debugLog(`[Live] PID assigned via transcript: ${sessionId.slice(0, 8)} → pid=${result}`);
    } else if (Array.isArray(result)) {
      const registeredPids = new Set(sessionPids.values());
      const newPid = result.find(p => !registeredPids.has(p));
      if (newPid) {
        sessionPids.set(sessionId, newPid);
        debugLog(`[Live] PID assigned via fallback: ${sessionId.slice(0, 8)} → pid=${newPid}`);
      }
    }
  });
}

/**
 * Count running Claude CLI processes (node.exe *claude*)
 */
function countClaudeProcesses(callback) {
  const { execFile } = require('child_process');
  if (process.platform === 'win32') {
    const psCmd = `(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*claude*' }).Count`;
    execFile('powershell.exe', ['-NoProfile', '-Command', psCmd], { timeout: 6000 }, (err, stdout) => {
      if (err || !stdout) return callback(0);
      callback(parseInt(stdout.trim(), 10) || 0);
    });
  } else {
    execFile('pgrep', ['-fc', 'node.*claude'], { timeout: 3000 }, (err, stdout) => {
      callback(parseInt((stdout || '').trim(), 10) || 0);
    });
  }
}

/**
 * Get jsonl file mtime (0 if not found)
 */
function getJsonlMtime(jsonlPath) {
  if (!jsonlPath) return 0;
  try {
    const resolved = jsonlPath.startsWith('~')
      ? path.join(os.homedir(), jsonlPath.slice(1))
      : jsonlPath;
    return fs.statSync(resolved).mtimeMs;
  } catch { return 0; }
}

// Zombie sweep: compare process count vs main agent count, remove oldest by mtime
let _zombieSweepRunning = false;
function zombieSweep(agentManager, debugLog) {
  if (_zombieSweepRunning) return;
  _zombieSweepRunning = true;

  const mainAgents = agentManager.getAllAgents().filter(a => !a.isSubagent);
  const mainCount = mainAgents.length;
  if (mainCount <= 1) { _zombieSweepRunning = false; return; }

  countClaudeProcesses((processCount) => {
    _zombieSweepRunning = false;
    if (processCount >= mainCount) return; // no excess avatars

    const excess = mainCount - processCount;
    debugLog(`[Live] Zombie sweep: ${processCount} processes, ${mainCount} agents → ${excess} excess`);

    // Sort by jsonl mtime ascending (oldest first)
    const sorted = mainAgents
      .map(a => ({ agent: a, mtime: getJsonlMtime(a.jsonlPath) }))
      .sort((a, b) => a.mtime - b.mtime);

    for (let i = 0; i < excess; i++) {
      const { agent } = sorted[i];
      debugLog(`[Live] Zombie sweep: removing ${agent.id.slice(0, 8)} (mtime=${new Date(sorted[i].mtime).toISOString()})`);
      sessionPids.delete(agent.id);
      agentManager.removeAgent(agent.id);
    }
  });
}

const LIVENESS_INTERVAL = 2000;
const GRACE_MS = 10000;
const ZOMBIE_SWEEP_INTERVAL = 30000;
const NO_PID_TIMEOUT = GRACE_MS + 10000;

function startLivenessChecker({ agentManager, debugLog }) {
  const zombieSweepId = setInterval(() => {
    if (agentManager) zombieSweep(agentManager, debugLog);
  }, ZOMBIE_SWEEP_INTERVAL);

  const livenessCheckId = setInterval(async () => {
    if (!agentManager) return;
    for (const agent of agentManager.getAllAgents()) {
      if (agent.firstSeen && (Date.now() - agent.firstSeen) < GRACE_MS) continue;

      const pid = sessionPids.get(agent.id);
      if (!pid) {
        retryPidDetection(agent.id, agentManager, debugLog);
        const noPidAge = Date.now() - (agent.firstSeen || 0);
        if (noPidAge > NO_PID_TIMEOUT) {
          // Solo agent protection: don't remove the only agent
          if (agentManager.getAgentCount() <= 1) {
            debugLog(`[Live] ${agent.id.slice(0, 8)} no PID but solo agent → keeping`);
            continue;
          }
          debugLog(`[Live] ${agent.id.slice(0, 8)} no PID for ${Math.round(noPidAge/1000)}s → removing`);
          agentManager.removeAgent(agent.id);
        }
        continue;
      }

      const alive = await checkLivenessTier1(agent.id, pid);
      if (alive) {
        if (agent.state === 'Offline') {
          agentManager.updateAgent({ ...agent, state: 'Waiting' }, 'live');
        }
        continue;
      }

      debugLog(`[Live] ${agent.id.slice(0, 8)} pid=${pid} dead → re-checking via transcript`);
      const newPid = await new Promise((resolve) => {
        detectClaudePidByTranscript(agent.jsonlPath, (result) => {
          if (typeof result === 'number') resolve(result);
          else if (Array.isArray(result)) {
            const registeredPids = new Set(sessionPids.values());
            resolve(result.find(p => !registeredPids.has(p) && p !== pid) || null);
          } else resolve(null);
        });
      });

      if (newPid) {
        sessionPids.set(agent.id, newPid);
        debugLog(`[Live] ${agent.id.slice(0, 8)} PID renewed: ${pid} → ${newPid}`);
        if (agent.state === 'Offline') {
          agentManager.updateAgent({ ...agent, state: 'Waiting' }, 'live');
        }
      } else {
        debugLog(`[Live] ${agent.id.slice(0, 8)} confirmed dead → removing`);
        sessionPids.delete(agent.id);
        agentManager.removeAgent(agent.id);
      }
    }
  }, LIVENESS_INTERVAL);

  return { zombieSweepId, livenessCheckId };
}

module.exports = { sessionPids, startLivenessChecker, detectClaudePidByTranscript };
