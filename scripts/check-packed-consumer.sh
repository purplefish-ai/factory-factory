#!/usr/bin/env bash
# Both phases use the same package spec and consumer directory after setup-node switches PATH.
set -euo pipefail
root="$PWD"
archive=("$root"/npm-package/factory-factory-*.tgz)
[[ ${#archive[@]} == 1 && -f "${archive[0]}" ]]
consumer="$RUNNER_TEMP/factory-factory-consumer"
mkdir -p "$consumer"
cd "$consumer"
node --version
npm --version
npm exec --yes --cache "$consumer/npm-cache" --package "${archive[0]}" -- \
  node "$root/scripts/check-packed-serve.mjs" "$consumer/npm-cache" "$1"
node "$root/scripts/check-installed-native-runtime.mjs" "$(cat installed-package.txt)"
