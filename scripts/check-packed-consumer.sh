#!/usr/bin/env bash
# Both phases use the same package spec and consumer directory after setup-node switches PATH.
set -euo pipefail
root="$PWD"
archive=("$root"/npm-package/factory-factory-*.tgz)
[[ ${#archive[@]} == 1 && -f "${archive[0]}" ]]
consumer="$RUNNER_TEMP/factory-factory-consumer"
mkdir -p "$consumer"
cd "$consumer"
# Keep the native npm package spec and cache path identical across Git Bash and Node versions.
if [[ ${RUNNER_OS:-} == Windows ]]; then
  root=$(cygpath -am "$root")
  archive[0]=$(cygpath -am "${archive[0]}")
  consumer=$(cygpath -am "$consumer")
fi
node --version
npm --version
npm exec --yes --cache "$consumer/npm-cache" --package "${archive[0]}" -- \
  node "$root/scripts/check-packed-serve.mjs" "$consumer/npm-cache" "$1"
node "$root/scripts/check-installed-native-runtime.mjs" "$(cat installed-package.txt)"
node "$root/scripts/check-installed-runtime-versions.mjs" "$(cat installed-package.txt)"
