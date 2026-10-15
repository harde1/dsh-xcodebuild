// Installing the optional tools, after the user has confirmed the exact commands.
//
// Pure: it turns the doctor's rows into argv lists and never runs anything itself, so
// the plan the panel shows and the plan the host executes are the same function's
// answer to the same rows.

const INSTALL_LINE = /^(brew|pipx) install ((?:[a-z0-9][a-z0-9._@+-]*)(?: [a-z0-9][a-z0-9._@+-]*)*)$/

const MANUAL_FIX = {
  brew: 'Homebrew is not installed — install it from https://brew.sh, then try again',
  pipx: 'pipx is not installed — run `brew install pipx` (or `python3 -m pip install --user pymobiledevice3`), then try again',
}

/**
 * What would be installed, and with which commands.
 *
 * Only `required: false` rows that are not ready are planned. A row's packages come
 * from its own `install` string, and only when it is exactly `brew install …` or
 * `pipx install …`; anything else is skipped rather than guessed at.
 *
 * @param {Array<{command: string, required: boolean, ready: boolean, install: string}>} tools - the doctor's rows.
 * @param {(command: string) => string|null} resolve - finds an installer's absolute path.
 * @returns {{steps: Array<{argv: string[], display: string, tools: string[]}>, skipped: Array<{tools: string[], reason: string}>, missing: string[]}} the plan.
 */
export function installPlan(tools, resolve) {
  // "ships with macOS/Xcode" is not something a package manager can fix.
  const missing = tools.filter((tool) => !tool.required && !tool.ready && !/^ships with/.test(String(tool.install ?? '')))
  /** @type {Map<string, {packages: string[], tools: string[]}>} */
  const byInstaller = new Map([['brew', { packages: [], tools: [] }], ['pipx', { packages: [], tools: [] }]])
  const unparsed = []
  for (const tool of missing) {
    const match = INSTALL_LINE.exec(String(tool.install ?? '').trim())
    if (match === null) {
      unparsed.push(tool.command)
      continue
    }
    const bucket = byInstaller.get(match[1])
    for (const pkg of match[2].split(' ')) if (!bucket.packages.includes(pkg)) bucket.packages.push(pkg)
    bucket.tools.push(tool.command)
  }

  const steps = []
  const skipped = []
  if (unparsed.length > 0) {
    skipped.push({ tools: unparsed, reason: 'no install command this panel can run; see the doctor row' })
  }
  for (const [installer, bucket] of byInstaller) {
    if (bucket.packages.length === 0) continue
    const path = resolve(installer)
    if (path === null) {
      skipped.push({ tools: bucket.tools, reason: MANUAL_FIX[installer] })
      continue
    }
    // brew takes every formula at once; pipx installs one package per call.
    const groups = installer === 'brew' ? [bucket.packages] : bucket.packages.map((pkg) => [pkg])
    for (const packages of groups) {
      steps.push({
        argv: [path, 'install', ...packages],
        display: `${installer} install ${packages.join(' ')}`,
        tools: installer === 'brew'
          ? bucket.tools
          : missing.filter((tool) => tool.install.trim() === `pipx install ${packages[0]}`).map((tool) => tool.command),
      })
    }
  }
  return { steps, skipped, missing: missing.map((tool) => tool.command) }
}
