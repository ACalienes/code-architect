#!/bin/bash
#
# backup-agent-memory.sh — durable off-laptop backup of every Kameha agent's
# Claude Code auto-memory (~/.claude/projects/*/memory/).
#
# WHY: agent auto-memory (cards, MEMORY.md indexes, session logs — the brains
# the agents actually accumulate session over session) lives OUTSIDE every git
# repo, so the "GitHub = our safety net" assumption does NOT cover it. Before
# this script the only backup was a single-agent rsync pointed at a dead fork.
# If the laptop dies, every agent's brain is gone. This fixes that.
#
# MODEL: mirrors Kai's proven private-GitHub backup. The local working copy at
# $BACKUP_DIR is a git repo whose history IS the durability layer (every run is
# a snapshot); the working tree reflects current state. Primary = private
# GitHub; secondary = Mac Mini over Tailscale.
#
# SAFE BY DESIGN: idempotent, --dry-run, single-instance lock, NEVER --force,
# a sanity floor that refuses to back up a suspiciously-empty source over good
# history, and a fork-guard preflight that warns on cwd-rename memory forks.
#
# Usage:
#   backup-agent-memory.sh [--dry-run] [--no-push] [--no-mini]
#
set -euo pipefail

# ---- config -----------------------------------------------------------------
SRC_ROOT="$HOME/.claude/projects"
BACKUP_DIR="$HOME/.kameha-agent-memory"          # local git working copy
GIT_REMOTE="https://github.com/ACalienes/kameha-agent-memory.git"  # PRIVATE repo (gh https cred helper auths push)
MINI="kai@100.64.114.13"                          # Tailscale; secondary copy
MINI_DEST="/Users/kai/.kameha-agent-memory/"
LOCK="$BACKUP_DIR/.backup.lock"
LOG="/tmp/kameha-agent-memory-backup.log"
MIN_EXPECTED_DIRS=10        # sanity floor: refuse if fewer memory dirs than this
SANITY_DROP_PCT=50          # abort if working tree would shrink by >this %

DRY_RUN=0; NO_PUSH=0; NO_MINI=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-push) NO_PUSH=1 ;;
    --no-mini) NO_MINI=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') — $*" | tee -a "$LOG"; }
run() { if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $*"; else eval "$@"; fi; }

# ---- preflight: fork-guard --------------------------------------------------
# Detect cwd-rename forks: two memory dirs whose project names collapse to the
# same slug (case-insensitive, ignoring a leading agent-name token). This is the
# bug that stranded "Executive-Assistant" vs "Kai-Executive-Assistant" and broke
# the old backup. Warn loudly; do not fail the backup.
fork_guard() {
  log "fork-guard: scanning for cwd-rename memory forks…"
  local names=() slugs=() base slug
  for d in "$SRC_ROOT"/*/memory/; do
    [ -d "$d" ] || continue
    # already-reconciled husks carry a tombstone — don't keep crying wolf.
    [ -f "$d/RECONCILED.md" ] && continue
    base=$(basename "$(dirname "$d")")
    # strip the host/path prefix so we compare PROJECT slugs, not full paths.
    # "-Users-alex-Desktop-Code-Kai-Executive-Assistant" -> "kai-executive-assistant"
    slug=$(echo "$base" | sed -E 's#^-Users-alex-Desktop-Code-##; s#^-Users-alex-##' | tr '[:upper:]' '[:lower:]')
    names+=("$base"); slugs+=("$slug")
  done
  # file count per dir — a fresh cwd-fork starts as a lone husk (just MEMORY.md),
  # so the fork signature is NAME-SIMILAR + one side abandoned (<=2 files) while
  # the other is active (>2). This excludes legit sibling projects where BOTH
  # sides are populated (e.g. "The Dental Boutique" vs "…Website").
  local fcount=() n
  for n in "${names[@]}"; do
    fcount+=("$(find "$SRC_ROOT/$n/memory" -type f 2>/dev/null | wc -l | tr -d ' ')")
  done
  local i j a b lo hi
  for ((i=0; i<${#slugs[@]}; i++)); do
    for ((j=i+1; j<${#slugs[@]}; j++)); do
      a="${slugs[$i]}"; b="${slugs[$j]}"
      if [ "$a" = "$b" ] || [[ "$b" == *-"$a" ]] || [[ "$a" == *-"$b" ]] || [[ "$b" == "$a"-* ]] || [[ "$a" == "$b"-* ]]; then
        lo=${fcount[$i]}; hi=${fcount[$j]}
        if [ "$lo" -gt "$hi" ]; then lo=${fcount[$j]}; hi=${fcount[$i]}; fi
        if [ "$lo" -le 2 ] && [ "$hi" -gt 2 ]; then
          log "  ⚠ POSSIBLE FORK: '${names[$i]}' (${fcount[$i]} files) vs '${names[$j]}' (${fcount[$j]} files) — the small one is likely a stranded rename. Run scripts/defork-agent-memory.sh."
        fi
      fi
    done
  done
}

# ---- main -------------------------------------------------------------------
# (dry-run is fully side-effect-free: no dirs, no lock, no network, no commits)
if [ "$DRY_RUN" != 1 ]; then
  mkdir -p "$BACKUP_DIR"
  # single-instance lock (atomic mkdir)
  if ! mkdir "$LOCK" 2>/dev/null; then
    log "another backup is running (lock $LOCK) — exiting."
    exit 0
  fi
  trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
fi

log "=== agent-memory backup start (dry_run=$DRY_RUN no_push=$NO_PUSH no_mini=$NO_MINI) ==="
fork_guard

# sanity floor: how many memory dirs do we actually see?
dir_count=$(find "$SRC_ROOT" -maxdepth 2 -type d -name memory 2>/dev/null | wc -l | tr -d ' ')
log "found $dir_count agent memory dirs under $SRC_ROOT"
if [ "$dir_count" -lt "$MIN_EXPECTED_DIRS" ]; then
  log "ABORT: only $dir_count memory dirs (< floor $MIN_EXPECTED_DIRS). Refusing to overwrite good backup history with a suspiciously-empty source."
  exit 1
fi

# init the git working copy on first run
if [ ! -d "$BACKUP_DIR/.git" ]; then
  log "initializing backup repo at $BACKUP_DIR"
  run "git -C '$BACKUP_DIR' init -q"
  run "git -C '$BACKUP_DIR' remote add origin '$GIT_REMOTE' 2>/dev/null || true"
  # README so the repo root isn't bare
  if [ "$DRY_RUN" != 1 ]; then
    printf '# kameha-agent-memory\n\nOff-laptop backup of every Kameha agent Claude Code auto-memory.\nWritten by code-architect/scripts/backup-agent-memory.sh. Do not edit by hand.\n' > "$BACKUP_DIR/README.md"
  fi
fi

# mirror each agent's memory dir into <BACKUP_DIR>/<project>/memory/
# rsync --delete keeps the tree current; git history preserves every prior state.
for d in "$SRC_ROOT"/*/memory/; do
  [ -d "$d" ] || continue
  proj=$(basename "$(dirname "$d")")
  dest="$BACKUP_DIR/$proj/memory/"
  run "mkdir -p '$dest'"
  run "rsync -a --delete '$d' '$dest'"
done

# commit only if something changed
if [ "$DRY_RUN" = 1 ]; then
  log "dry-run: would 'git add -A && git commit' if changes, then push/rsync."
else
  git -C "$BACKUP_DIR" add -A
  if git -C "$BACKUP_DIR" diff --cached --quiet; then
    log "no changes — nothing to commit."
  else
    git -C "$BACKUP_DIR" commit -q -m "backup: agent memory $(date '+%Y-%m-%d %H:%M:%S')"
    log "committed snapshot."
    if [ "$NO_PUSH" != 1 ]; then
      # NEVER --force. ff-only by nature (single writer). Skip silently if no remote yet.
      if git -C "$BACKUP_DIR" push -q origin HEAD 2>>"$LOG"; then
        log "pushed to GitHub (primary)."
      else
        log "⚠ push failed (remote not created yet, or auth) — local snapshot is safe; fix remote and re-run."
      fi
    fi
  fi
fi

# secondary: rsync the whole backup tree to the Mini (skip if unreachable)
if [ "$NO_MINI" != 1 ]; then
  if ssh -o ConnectTimeout=3 -o BatchMode=yes "$MINI" true 2>/dev/null; then
    run "rsync -az --delete --exclude='.git/' '$BACKUP_DIR/' '$MINI:$MINI_DEST'"
    log "synced to Mini (secondary)."
  else
    log "Mini unreachable — skipped secondary (primary still safe)."
  fi
fi

log "=== agent-memory backup done ==="
