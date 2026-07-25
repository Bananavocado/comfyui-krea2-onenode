#!/usr/bin/env bash
# Double-click me in Finder. Runs install_deps.sh in a Terminal window and
# keeps it open so you can read the output.
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
./install_deps.sh "$@"
status=$?
echo
echo "Done (exit $status). Close this window when you're finished reading."
exit $status
