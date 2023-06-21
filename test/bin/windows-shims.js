const t = require('tap')
const { spawnSync } = require('child_process')
const { resolve, join, extname, sep } = require('path')
const { readFileSync, chmodSync, readdirSync } = require('fs')
const Diff = require('diff')
const { sync: which } = require('which')
const { version } = require('../../package.json')

const ROOT = resolve(__dirname, '../..')
const BIN = join(ROOT, 'bin')
const SHIMS = readdirSync(BIN).reduce((acc, shim) => {
  if (extname(shim) !== '.js') {
    acc[shim] = readFileSync(join(BIN, shim), 'utf-8')
  }
  return acc
}, {})

// windows requires each segment of a command path to be quoted when using shell: true
const quoteWhich = (cmd) => which(cmd)
  .split(sep)
  .map(p => p.includes(' ') ? `"${p}"` : p)
  .join(sep)

t.test('shim contents', t => {
  // these scripts should be kept in sync so this tests the contents of each
  // and does a diff to ensure the only differences between them are necessary
  const diffFiles = (npm, npx) => Diff.diffChars(npm, npx)
    .filter(v => v.added || v.removed)
    .reduce((acc, v) => {
      if (v.value.length === 1) {
        acc.letters.add(v.value.toUpperCase())
      } else {
        acc.diff.push(v.value)
      }
      return acc
    }, { diff: [], letters: new Set() })

  t.plan(3)

  t.test('bash', t => {
    const { diff, letters } = diffFiles(SHIMS.npm, SHIMS.npx)
    t.match(diff[0].split('\n').reverse().join(''), /^NPX_CLI_JS=/, 'has NPX_CLI')
    t.equal(diff.length, 1)
    t.strictSame([...letters], ['M', 'X'], 'all other changes are m->x')
    t.end()
  })

  t.test('cmd', t => {
    const { diff, letters } = diffFiles(SHIMS['npm.cmd'], SHIMS['npx.cmd'])
    t.match(diff[0], /^SET "NPX_CLI_JS=/, 'has NPX_CLI')
    t.equal(diff.length, 1)
    t.strictSame([...letters], ['M', 'X'], 'all other changes are m->x')
    t.end()
  })

  t.test('pwsh', t => {
    const { diff, letters } = diffFiles(SHIMS['npm.ps1'], SHIMS['npx.ps1'])
    t.equal(diff.length, 0)
    t.strictSame([...letters], ['M', 'X'], 'all other changes are m->x')
    t.end()
  })
})

t.test('run shims', t => {
  const path = t.testdir({
    ...SHIMS,
    'node.exe': readFileSync(process.execPath),
    // simulate the state where one version of npm is installed
    // with node, but we should load the globally installed one
    'global-prefix': {
      node_modules: {
        npm: t.fixture('symlink', ROOT),
      },
    },
    // put in a shim that ONLY prints the intended global prefix,
    // and should not be used for anything else.
    node_modules: {
      npm: {
        bin: {
          'npx-cli.js': `throw new Error('this should not be called')`,
          'npm-cli.js': `
            const assert = require('assert')
            const args = process.argv.slice(2)
            assert.equal(args[0], 'prefix')
            assert.equal(args[1], '-g')
            const { resolve } = require('path')
            console.log(resolve(__dirname, '../../../global-prefix'))
          `,
        },
      },
    },
  })

  const spawn = (cmd, args, opts) => {
    const result = spawnSync(cmd, args, {
      // don't hit the registry for the update check
      env: { PATH: path, npm_config_update_notifier: 'false' },
      cwd: path,
      windowsHide: true,
      ...opts,
    })
    result.stdout = result.stdout.toString().trim()
    result.stderr = result.stderr.toString().trim()
    return result
  }

  for (const shim of Object.keys(SHIMS)) {
    chmodSync(join(path, shim), 0o755)
  }

  const { ProgramFiles = '', SystemRoot = '', NYC_CONFIG, WINDOWS_SHIMS_TEST } = process.env
  const failOnMissing = WINDOWS_SHIMS_TEST === 'fail'
  const defaultSkip = process.platform === 'win32' ? null : 'test on relevant on windows'

  const matchSpawn = (t, cmd, bin = '', { skip = defaultSkip, name } = {}) => {
    const testName = `${name || cmd} ${bin}`.trim()
    if (skip) {
      if (failOnMissing) {
        t.fail(testName)
      } else {
        t.skip(`${testName} - ${skip}`)
      }
      return
    }
    t.test(testName, t => {
      t.plan(1)
      const isNpm = testName.includes('npm')
      const binArg = isNpm ? 'help' : '--version'
      const args = []
      const opts = {}
      if (cmd.endsWith('.cmd')) {
        args.push(binArg)
      } else if (cmd === 'pwsh') {
        cmd = quoteWhich(cmd)
        args.push(`${bin}.ps1`, binArg)
        opts.shell = true
      } else if (cmd.endsWith('bash.exe')) {
        // only cygwin *requires* the -l, but the others are ok with it
        args.push('-l', bin, binArg)
      }
      t.match(spawn(cmd, args, opts), {
        status: 0,
        signal: null,
        stderr: '',
        stdout: isNpm ? `npm@${version} ${ROOT}` : version,
      }, 'command output is correct')
    })
  }

  // ensure that all tests are either run or skipped
  t.plan(12)

  matchSpawn(t, 'npm.cmd')
  matchSpawn(t, 'npx.cmd')
  matchSpawn(t, 'pwsh', 'npm')
  matchSpawn(t, 'pwsh', 'npx')

  const bashes = [
    { name: 'git', cmd: join(ProgramFiles, 'Git', 'bin', 'bash.exe') },
    { name: 'user git', cmd: join(ProgramFiles, 'Git', 'usr', 'bin', 'bash.exe') },
    { name: 'wsl', cmd: join(SystemRoot, 'System32', 'bash.exe') },
    {
      name: 'cygwin',
      cmd: join(SystemRoot, '/', 'cygwin64', 'bin', 'bash.exe'),
      skip: NYC_CONFIG ? 'does not play nicely with nyc' : undefined,
    },
  ].map(({ name, cmd, skip = defaultSkip }) => {
    if (!skip) {
      try {
        // If WSL is installed, it *has* a bash.exe, but it fails if
        // there is no distro installed, so we need to detect that.
        if (spawnSync(cmd, ['-l', '-c', 'exit 0']).status !== 0) {
          throw new Error('not installed')
        }
      } catch (err) {
        skip = err.message
      }
    }
    return { cmd, skip, name: `${name} bash` }
  })

  for (const { cmd, skip, name } of bashes) {
    matchSpawn(t, cmd, 'npm', { name, skip })
    matchSpawn(t, cmd, 'npx', { name, skip })
  }
})
