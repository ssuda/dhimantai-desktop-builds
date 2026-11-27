#!/bin/sh
# Learning 0.39.104 restarts this path with no arguments after the old desktop
# exits. Its detached helper still has the extension host's Electron Node mode.
case ${VSCODE_PID:-} in
    ''|*[!0-9]*) ;;
    *)
        if [ "$#" -eq 0 ] && [ "${ELECTRON_RUN_AS_NODE:-}" = 1 ] && [ ! -d "/proc/$VSCODE_PID" ]; then
            unset ELECTRON_RUN_AS_NODE
        fi
        ;;
esac

launcher=$(readlink -f -- "$0") || exit 1
exec "${launcher%/*}/dhimantai-electron" "$@"
