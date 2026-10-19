#!/bin/sh
# Pacman owns URL selection, archive signatures, and the .part rename.
# Transport retries never repeat package transactions or change the snapshot.
set -eu
if test "$#" -ne 2; then
    exit 2
fi
exec /usr/bin/curl -q --fail --location --silent --show-error \
    --connect-timeout 15 --max-time 120 \
    --retry 2 --retry-delay 2 --retry-max-time 300 \
    --remove-on-error --output "$2" "$1"
