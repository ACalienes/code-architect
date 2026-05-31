'use strict';
/**
 * PM2 launch spec for the boardroom (Shared Layer) processes on the Mini.
 *
 * WHY THIS EXISTS: there was no committed ecosystem config for shared-layer — processes were started by
 * ad-hoc `pm2 start` invocations, and four of the emitters ended up with PM2's own filesystem-watch
 * (`watch: true`) turned ON with no `ignore_watch`. That made every redeploy / `sync-repos.sh` ff-pull /
 * sibling state-file write inside this directory trigger a PM2 reload — the root cause of the
 * `board-emit-cfo` restart "loop" (and the same latent bug in board-emit-{artifacts,outbox,mesh}).
 * Per "silent-failure is a class, not instances": ALL board processes are pinned to `watch: false` here.
 *
 * The emitters still run their OWN internal loop via the `--watch` SCRIPT arg (distinct from PM2's watch);
 * that's what keeps them alive on a 30s setInterval. `autorestart: true` stays as the crash safety net.
 *
 * Deploy on the Mini:  pm2 start ecosystem.config.js               # all
 *                      pm2 start ecosystem.config.js --only board-emit-cfo
 *                      pm2 save                                     # persist to dump.pm2
 *
 * Paths are resolved from this file's location (`cwd: __dirname`), so it is host-portable as long as the
 * shared-layer checkout sits together. The board processes read their DB from $HOME/.kameha (HOME-based,
 * not cwd-based), so cwd is functionally neutral; it is pinned here only for deterministic relative scripts.
 */
const path = require('node:path');
const HERE = __dirname;
const GATEWAY_URL = process.env.BOARD_URL || 'http://100.64.114.13:3351';
const CFO_DIR = process.env.CFO_DIR || path.join(process.env.HOME || '/Users/kai', 'CFO');

// Shared defaults for every board process. watch:false is the load-bearing fix.
const base = { cwd: HERE, watch: false, autorestart: true, time: true };

module.exports = {
  apps: [
    // ── substrate (no internal loop arg; long-lived servers / listeners) ──────────────────────────
    { ...base, name: 'board-gateway',   script: 'board-gateway.js' },
    { ...base, name: 'board-drainer',   script: 'board-listener.js' },
    { ...base, name: 'board-sync',      script: 'board-sync.js' },
    { ...base, name: 'board-ledger',    script: 'board-ledger.js' },
    { ...base, name: 'board-supervisor',script: 'board-supervisor.js' },

    // ── emitters (each runs a 30s internal loop via the SCRIPT arg `--watch`) ─────────────────────
    { ...base, name: 'board-emit-cfo',       script: 'board-emit-cfo.js',       args: '--watch', env: { CFO_DIR } },
    { ...base, name: 'board-emit-artifacts', script: 'board-emit-artifacts.js', args: '--watch', env: { BOARD_URL: GATEWAY_URL } },
    { ...base, name: 'board-emit-outbox',    script: 'board-emit-outbox.js',    args: '--watch', env: { BOARD_URL: GATEWAY_URL } },
    { ...base, name: 'board-emit-mesh',      script: 'board-emit-mesh.js',      args: '--watch', env: { BOARD_URL: GATEWAY_URL } },

    // Phase-1 health emitter — watches the SoR itself (process_down / flapping / backlog). Runs LOCAL
    // (no BOARD_URL → writes kameha-mesh.db directly as source_agent 'health'), so it needs no gateway token.
    { ...base, name: 'board-emit-health',    script: 'board-emit-health.js',    args: '--watch' },
  ],
};
