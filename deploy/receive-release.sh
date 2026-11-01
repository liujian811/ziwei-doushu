#!/usr/bin/env bash
# Root-owned SSH forced command; executes as the unprivileged ziwei user.
set -Eeuo pipefail
umask 027

readonly ROOT=/opt/ziwei-doushu
readonly SERVICE=ziwei-doushu.service
readonly HEALTH_URL=http://127.0.0.1:3080
stage=''
archive=''
switched=0
previous=''

log() { printf '%s\n' "$*" >&2; }
fail() { log "ERROR: $*"; exit 1; }

healthy() {
  local expected=$1 observed_revision attempt
  for attempt in $(seq 1 30); do
    observed_revision=$(curl --fail --silent --show-error --max-time 3 \
      "$HEALTH_URL/deployment-revision.txt" 2>/dev/null) || observed_revision=''
    if [[ "$observed_revision" == "$expected" ]] && \
      curl --fail --silent --show-error --max-time 5 "$HEALTH_URL/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

set_current() {
  local target=$1
  ln -s "$target" "$ROOT/.current-$$"
  mv -Tf "$ROOT/.current-$$" "$ROOT/current"
}

cleanup() {
  local result=$?
  trap - EXIT HUP INT TERM
  if (( result != 0 && switched == 1 )); then
    log 'Deployment failed; restoring the previous release.'
    if [[ -n "$previous" ]]; then
      if set_current "$previous" && sudo -n /usr/bin/systemctl restart "$SERVICE" && \
        healthy "${previous##*/}"; then
        log "Rollback healthy: ${previous##*/}"
      else
        log 'ERROR: rollback did not become healthy; administrator intervention is required.'
      fi
    else
      rm -f "$ROOT/current"
      sudo -n /usr/bin/systemctl stop "$SERVICE" || \
        log 'ERROR: failed to deactivate the first deployment; inspect systemd.'
      log 'No previous release existed; current was removed and service deactivated.'
    fi
  fi
  [[ -z "$stage" ]] || rm -rf -- "$stage"
  [[ -z "$archive" ]] || rm -f -- "$archive"
  rm -f -- "$ROOT/.current-$$" "$ROOT/.previous-$$"
  exit "$result"
}

# authorized_keys forces this script; arbitrary SSH commands are rejected.
[[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^deploy\ ([0-9a-f]{40})$ ]] || \
  fail 'Expected: deploy <40-character lowercase commit SHA>'
readonly revision="${BASH_REMATCH[1]}"
readonly release="$ROOT/releases/$revision"
[[ $(id -un) == ziwei ]] || fail 'This command must run as ziwei.'
[[ -d "$ROOT/releases" && -d "$ROOT/tmp" ]] || fail 'Server directories are not initialized.'
exec 9>"$ROOT/.deploy.lock"
flock -w 300 9 || fail 'Another deployment still holds the lock.'
[[ ! -e "$release" && ! -L "$release" ]] || fail 'Release already exists; refusing to overwrite it.'
if [[ -e "$ROOT/current" || -L "$ROOT/current" ]]; then
  [[ -L "$ROOT/current" ]] || fail 'current must be a symbolic link.'
  previous=$(readlink -f "$ROOT/current")
  [[ "$previous" =~ ^/opt/ziwei-doushu/releases/[0-9a-f]{40}$ && -f "$previous/server.js" ]] || \
    fail 'current does not refer to a valid release.'
fi

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
archive=$(mktemp "$ROOT/tmp/release.XXXXXXXX.tar.gz")
stage=$(mktemp -d "$ROOT/releases/.incoming.XXXXXXXX")
cat >"$archive"

# Extract without archive owners, devices, setuid bits, escaping links, or
# writes through symlink ancestors. Requires Python 3, not a pip dependency.
python3 - "$archive" "$stage" <<'PY'
import pathlib
import shutil
import sys
import tarfile

destination = pathlib.Path(sys.argv[2]).resolve()
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    entries = {}
    for member in members:
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts:
            raise ValueError(f'Unsafe archive path: {member.name}')
        if not (member.isdir() or member.isfile() or member.issym()):
            raise ValueError(f'Unsupported archive entry: {member.name}')
        if str(path) == '.':
            if not member.isdir():
                raise ValueError('Archive root must be a directory')
            continue
        if path in entries:
            raise ValueError(f'Duplicate archive entry: {member.name}')
        entries[path] = member
        if member.issym():
            link = pathlib.PurePosixPath(member.linkname)
            target = (destination / str(path.parent) / str(link)).resolve()
            if link.is_absolute() or not target.is_relative_to(destination):
                raise ValueError(f'Escaping symlink: {member.name}')
    symlinks = {path for path, member in entries.items() if member.issym()}
    for path in entries:
        if any(parent in symlinks for parent in path.parents):
            raise ValueError(f'Symlink ancestor: {path}')
    for path, member in entries.items():
        target = destination / str(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if member.isdir():
            target.mkdir(exist_ok=True)
            target.chmod(0o755)
        elif member.isfile():
            with archive.extractfile(member) as source, target.open('xb') as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o755 if member.mode & 0o111 else 0o644)
    for path in symlinks:
        (destination / str(path)).symlink_to(entries[path].linkname)
    # Resolve the complete link graph too: individually safe relative targets
    # can escape when a chain changes the meaning of a later '..' component.
    for path in symlinks:
        if not (destination / str(path)).resolve().is_relative_to(destination):
            raise ValueError(f'Escaping symlink chain: {path}')
PY

[[ -f "$stage/server.js" && -d "$stage/.next/static" ]] || fail 'Missing Next.js standalone output or static assets.'
[[ -f "$stage/public/deployment-revision.txt" ]] || fail 'Missing deployment revision.'
[[ "$(cat "$stage/public/deployment-revision.txt")" == "$revision" ]] || fail 'Artifact revision does not match the requested commit.'
mv -T "$stage" "$release"
stage=''
if [[ -n "$previous" ]]; then
  ln -s "$previous" "$ROOT/.previous-$$"
  mv -Tf "$ROOT/.previous-$$" "$ROOT/previous"
fi
set_current "$release"
switched=1
sudo -n /usr/bin/systemctl restart "$SERVICE"
healthy "$revision" || fail 'New release failed its HTTP and revision checks.'
switched=0
log "Deployment healthy: $revision"
