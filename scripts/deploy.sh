#!/usr/bin/env bash
#
# Build the site and publish it to the VPS.
#
#   npm run deploy                 build, then upload what changed
#   npm run deploy -- --dry-run    build, then list what would change, without changing it
#   npm run deploy -- --prune      also delete old build files from the server (asks first)
#   npm run deploy -- --no-build   upload the existing dist/ as it is
#
# How it works:
#   * rsync compares file contents and sends only what changed, so the big textures go
#     up once. Unchanged files keep their timestamps on the server, so browsers that
#     already cached them don't download them again.
#   * Scripts, styles and textures are uploaded before the HTML pages that reference
#     them, so a visitor never gets a page whose assets aren't on the server yet.
#     --prune removes old files only after the new pages are live.
#   * groups/ on the server is never touched: the nightly TLE job keeps it current
#     there, and the copy in dist/ (the committed index.json) would overwrite it.
#   * If your user can write to the web root, files go straight there. Otherwise they
#     are uploaded to ~/site-staging on the server and copied into place with sudo
#     (you'll be asked for your sudo password).
#
# Settings can be overridden from the environment, e.g. DEPLOY_HOST=myvps npm run deploy

set -euo pipefail

HOST="${DEPLOY_HOST:-jackiepi-xyz-uswest}"                # ssh host or ~/.ssh/config alias
WEB_ROOT="${DEPLOY_WEB_ROOT:-/var/www/jackiepi.xyz/html}" # directory nginx serves
STAGING="${DEPLOY_STAGING:-site-staging}"                 # in your remote home; sudo mode only
URL="${DEPLOY_URL:-https://jackiepi.xyz/}"                # checked against dist/index.html at the end

# Never uploaded, and never deleted from the server:
#   groups/       satellite data written there by the nightly TLE job
#   .well-known/  certbot challenges and other site-verification files
PROTECT=(--exclude=/groups/ --exclude=/.well-known/ --exclude=.DS_Store)
# The same rule for --prune, which also leaves HTML pages alone.
LIST_FILES='find . -type f ! -path "./groups/*" ! -path "./.well-known/*" ! -name .DS_Store ! -name "*.html" | LC_ALL=C sort'

usage() { sed -n '3,/^$/s/^# \{0,1\}//p' "$0"; }
die() { echo "deploy: $*" >&2; exit 1; }

build=1 dry_run=0 prune=0
for arg in "$@"; do
    case $arg in
        -n|--dry-run) dry_run=1 ;;
        --prune) prune=1 ;;
        --no-build) build=0 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $arg" ;;
    esac
done

cd "$(dirname "$0")/.."
command -v rsync >/dev/null || die "rsync is not installed on this computer"

if (( build )); then
    npm run build
fi
[[ -f dist/index.html ]] || die "dist/index.html is missing; run without --no-build"

# Share one SSH connection (and one login) between every step below. The socket lives
# in a short path because macOS limits socket paths to 104 characters.
ctl_dir=$(mktemp -d /tmp/deploy.XXXXXX)
ssh_cmd="ssh -o ControlMaster=auto -o ControlPath=$ctl_dir/s -o ControlPersist=120"
cleanup() {
    $ssh_cmd -O exit "$HOST" 2>/dev/null || true
    rm -rf "$ctl_dir"
}
trap cleanup EXIT

root_q=$(printf %q "$WEB_ROOT")
state=$($ssh_cmd -n "$HOST" "command -v rsync >/dev/null && echo has-rsync; \
    test -d $root_q && echo has-root; test -w $root_q && echo writable; true") \
    || die "could not connect to $HOST"
[[ $state == *has-rsync* ]] || die "rsync is not installed on $HOST (Debian/Ubuntu: sudo apt install rsync)"
[[ $state == *has-root* ]] || die "$WEB_ROOT does not exist on $HOST"
writable=0
if [[ $state == *writable* ]]; then writable=1; fi

# -c compares contents (every build gives every file a new timestamp, so times are useless
# here). No -t: a file is only rewritten, and its timestamp only changes, when it changed.
rsync_cmd=(rsync -rlpc -e "$ssh_cmd")

stale=""
if (( prune )); then
    stale=$(LC_ALL=C comm -13 <(cd dist && eval "$LIST_FILES") \
        <($ssh_cmd -n "$HOST" "cd $root_q && $LIST_FILES") | sed 's|^\./||')
    if [[ -z $stale ]]; then
        echo "Nothing to prune: every file on the server is part of this build."
    else
        echo "On the server but not in this build:"
        echo "  ${stale//$'\n'/$'\n'  }"
        if (( dry_run )); then
            echo "(dry run: you would be asked before these are deleted)"
        else
            read -r -p "Delete them after uploading? [y/N] " answer
            if [[ $answer != [yY]* ]]; then stale=""; fi
        fi
    fi
fi

if (( dry_run )); then
    echo "Dry run: files that would be uploaded to $HOST:$WEB_ROOT"
    "${rsync_cmd[@]}" -n -v "${PROTECT[@]}" dist/ "$HOST:$WEB_ROOT/"
    exit 0
fi

if (( writable )); then
    echo "Uploading to $HOST:$WEB_ROOT"
    "${rsync_cmd[@]}" -v "${PROTECT[@]}" --exclude='*.html' dist/ "$HOST:$WEB_ROOT/"
    "${rsync_cmd[@]}" -v dist/*.html "$HOST:$WEB_ROOT/"
else
    echo "Your user can't write to $WEB_ROOT, so uploading to ~/$STAGING and copying it in with sudo"
    "${rsync_cmd[@]}" -v --delete "${PROTECT[@]}" dist/ "$HOST:$STAGING/"
    stage_q=$(printf %q "$STAGING")
    $ssh_cmd -t "$HOST" "sudo rsync -rlpc --exclude='*.html' $stage_q/ $root_q/ \
        && sudo rsync -rlpc $stage_q/*.html $root_q/"
fi

if [[ -n $stale ]]; then
    rm_args=$(while read -r f; do printf '%q ' "$f"; done <<< "$stale")
    if (( writable )); then
        $ssh_cmd -n "$HOST" "cd $root_q && rm -f -- $rm_args"
    else
        $ssh_cmd -t "$HOST" "cd $root_q && sudo rm -f -- $rm_args"
    fi
    echo "Deleted $(wc -l <<< "$stale" | tr -d ' ') old files."
fi

if command -v curl >/dev/null; then
    if curl -fsS --max-time 15 "$URL" 2>/dev/null | cmp -s - dist/index.html; then
        echo "Done: $URL is serving the new build."
    else
        echo "deploy: uploaded, but $URL doesn't match dist/index.html yet; check the site" >&2
    fi
fi
