#!/usr/bin/env node
/**
 * code-architect — single-shot CLI entry.
 *
 * Phase 1 W3 scope: --help, --version, `memory doctor`.
 * Every other subcommand stubs with the deferred phase it lands in.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const pkg = require('../package.json');

const args = process.argv.slice(2);

function usage() {
  console.log(`code-architect ${pkg.version}

Engineering capacity for the Kameha mesh.

Usage:
  code-architect <command> [options]

Commands (Phase 1 W3 — current):
  memory doctor              Run cap + source-integrity checks (exits 0/1/2/3)
  --help, -h                 Show this help
  --version, -v              Show version

Commands (Phase 2 W4 — stubs):
  implement <task>           Execute a planned change with run-ledger
  map                        Walk manifests + emit cross-cutting DAG
  rollback <run-id>          Reverse a completed run
  status                     Read heartbeat + recent run state

Commands (later):
  memory restore <slug>      Restore an archived card with rationale
  memory re-distill          Refresh source hashes after methodology edit
  owners migrate --to=N      Walk all repos, apply owners.json schema migration

See ./CLAUDE.md for invocation-time context + boundaries.
`);
}

function notYetImplemented(cmd, phase) {
  console.error(`code-architect: '${cmd}' not yet implemented. Lands in ${phase}.`);
  console.error(`See methodology.md + project_code_architect_scope_v3_2026-05-10.md for the design.`);
  process.exit(64); // EX_USAGE
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  usage();
  process.exit(0);
}

if (args[0] === '--version' || args[0] === '-v') {
  console.log(pkg.version);
  process.exit(0);
}

const [cmd, ...rest] = args;

switch (cmd) {
  case 'memory': {
    const sub = rest[0];
    if (sub === 'doctor') {
      const doctorPath = path.join(__dirname, 'lib', 'memory-doctor.js');
      const result = spawnSync(process.execPath, [doctorPath, ...rest.slice(1)], { stdio: 'inherit' });
      process.exit(result.status ?? 1);
    }
    if (sub === 'restore') notYetImplemented('memory restore', 'Phase 2 W4');
    if (sub === 're-distill') notYetImplemented('memory re-distill', 'Phase 2 W4');
    console.error(`code-architect memory: unknown subcommand '${sub}'. Try: doctor | restore | re-distill`);
    process.exit(64);
  }
  case 'implement':
    notYetImplemented('implement', 'Phase 2 W4 (needs run-ledger.js)');
  case 'map':
    notYetImplemented('map', 'Phase 2 W4 (needs CA registry walk)');
  case 'rollback':
    notYetImplemented('rollback', 'Phase 2 W4 (needs run-ledger.js)');
  case 'status':
    notYetImplemented('status', 'Phase 2 W4 (needs heartbeat cron from §10.7)');
  case 'owners':
    notYetImplemented(`owners ${rest[0] || ''}`.trim(), 'Phase 2 W4+ (needs owners.json schema migrator)');
  default:
    console.error(`code-architect: unknown command '${cmd}'`);
    usage();
    process.exit(64);
}
