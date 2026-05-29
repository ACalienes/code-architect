#!/bin/bash
#
# defork-agent-memory.sh — reconcile cwd-rename memory forks.
#
# WHY: Claude Code keys auto-memory by working-directory path. When a repo is
# renamed, the agent silently starts a FRESH empty brain at the new path and the
# old brain is stranded (and any backup pointed at the old path keeps protecting
# a husk). Two such orphans exist:
#   - "Executive-Assistant"  -> live "Kai-Executive-Assistant"   (Kai, frozen Feb-19)
#   - "kameha-lead-engine"   -> live "Kameha-Lead-Engine"        (LE)
#
# SAFE BY DESIGN: never deletes. Copies the orphan's content into the LIVE
# counterpart's archive/ (so it's preserved AND backed up going forward), then
# drops a RECONCILED.md tombstone in the orphan so it's not re-flagged. The
# orphan's content reconciles into its OWN agent's space — sovereignty intact,
# no cross-agent contamination. Idempotent + --dry-run.
#
# Usage: defork-agent-memory.sh [--dry-run]
#
set -euo pipefail

PROJ_ROOT="$HOME/.claude/projects"
STAMP=$(date '+%Y-%m-%d')
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

# orphan-dir-name|live-dir-name
PAIRS=(
  "-Users-alex-Desktop-Code-Executive-Assistant|-Users-alex-Desktop-Code-Kai-Executive-Assistant"
  "-Users-alex-kameha-lead-engine|-Users-alex-Desktop-Code-Kameha-Lead-Engine"
)

run() { if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }

for pair in "${PAIRS[@]}"; do
  orphan="${pair%%|*}"; live="${pair##*|}"
  osrc="$PROJ_ROOT/$orphan/memory"
  ldst="$PROJ_ROOT/$live/memory/archive/orphan-${orphan}-reconciled-${STAMP}"

  echo "── $orphan  →  $live"
  if [ ! -d "$osrc" ]; then echo "  orphan memory dir not found, skipping."; continue; fi
  if [ ! -d "$PROJ_ROOT/$live/memory" ]; then echo "  ⚠ live counterpart memory dir not found — NOT reconciling (verify path)."; continue; fi
  if [ -f "$osrc/RECONCILED.md" ]; then echo "  already reconciled (tombstone present), skipping."; continue; fi

  echo "  archiving orphan content → $ldst"
  run "mkdir -p '$ldst'"
  # copy everything EXCEPT a prior tombstone; preserve timestamps
  run "rsync -a --exclude='RECONCILED.md' '$osrc/' '$ldst/'"

  echo "  writing tombstone in orphan"
  if [ "$DRY_RUN" != 1 ]; then
    cat > "$osrc/RECONCILED.md" <<EOF
# RECONCILED — this is a stranded cwd-rename fork

This directory is the orphaned auto-memory for a repo that was later renamed.
Its content was preserved (read-only) into the live agent's brain on ${STAMP}:

    ${live}/memory/archive/orphan-${orphan}-reconciled-${STAMP}/

Do not write here. The live brain is:  ${live}
Reconciled by code-architect/scripts/defork-agent-memory.sh.
EOF
  else
    echo "  [dry-run] would write $osrc/RECONCILED.md"
  fi
  echo "  done."
done

echo ""
echo "Note: orphan dirs are intentionally NOT deleted (preserve > assume)."
echo "Their content now lives in the live brains' archive/ and will be backed up."
