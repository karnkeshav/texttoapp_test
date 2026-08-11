/**
 * kill-port.js — prestart hook
 *
 * Frees PORT (default 3000) before the server starts so `npm start`
 * never dies with EADDRINUSE, even if a previous process is still running.
 *
 * Windows : netstat -ano + taskkill
 * Unix    : fuser -k <port>/tcp
 */

'use strict';

const { execSync } = require('child_process');
const PORT = process.env.PORT || 3000;

try {
  if (process.platform === 'win32') {
    let raw;
    try {
      raw = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' });
    } catch (_) {
      // findstr exits 1 when nothing matches — port is already free
      process.exit(0);
    }

    const pids = [
      ...new Set(
        raw
          .split('\n')
          .filter((line) => line.includes('LISTENING'))
          .map((line) => line.trim().split(/\s+/).pop())
          .filter((pid) => pid && pid !== '0')
      ),
    ];

    if (pids.length === 0) process.exit(0);

    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      } catch (_) {
        // Process may have already exited
      }
    }

    console.log(
      `[prestart] Freed port ${PORT} — killed PID${pids.length > 1 ? 's' : ''}: ${pids.join(', ')}`
    );
  } else {
    // Unix / macOS
    try {
      execSync(`fuser -k ${PORT}/tcp`, { stdio: 'ignore' });
      console.log(`[prestart] Freed port ${PORT}`);
    } catch (_) {
      // Port was already free
    }
  }
} catch (err) {
  // Non-fatal — let the server start and surface its own error if needed
  console.warn(`[prestart] kill-port warning: ${err.message}`);
}
