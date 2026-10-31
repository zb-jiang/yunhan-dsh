import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseDesktopHomeArgument, resolveDesktopHome } from '../src/home-resolution.ts'
import { resolveDesktopPaths } from '../src/paths.ts'

/** Platform-appropriate absolute path samples; `isAbsolute` judges both forms. */
const ABSOLUTE = process.platform === 'win32' ? 'D:\\dsh-alt' : '/dsh-alt'
const ABSOLUTE_OTHER = process.platform === 'win32' ? 'E:\\dsh-other' : '/dsh-other'

describe('parseDesktopHomeArgument', () => {
  it('returns undefined without the flag', () => {
    expect(parseDesktopHomeArgument([])).toBeUndefined()
    expect(parseDesktopHomeArgument(['--updated', '-v'])).toBeUndefined()
  })

  it('accepts both `--dsh-home <path>` and `--dsh-home=<path>`', () => {
    expect(parseDesktopHomeArgument([ABSOLUTE])).toBeUndefined()
    expect(parseDesktopHomeArgument(['--dsh-home', ABSOLUTE])).toBe(ABSOLUTE)
    expect(parseDesktopHomeArgument([`--dsh-home=${ABSOLUTE}`])).toBe(ABSOLUTE)
  })

  it('lets a later occurrence win', () => {
    expect(parseDesktopHomeArgument([`--dsh-home=${ABSOLUTE}`, '--dsh-home', ABSOLUTE_OTHER])).toBe(ABSOLUTE_OTHER)
  })

  it('rejects a missing value', () => {
    expect(() => parseDesktopHomeArgument(['--dsh-home'])).toThrow('--dsh-home requires an absolute directory path')
  })

  it.each([
    ['an empty value', '--dsh-home='],
    ['a NUL byte', `--dsh-home=${ABSOLUTE}\0x`],
    ['a relative path', '--dsh-home=dsh-alt'],
  ])('rejects %s', (_name, argument) => {
    expect(() => parseDesktopHomeArgument([argument])).toThrow('--dsh-home requires')
  })
})

describe('resolveDesktopHome', () => {
  it('resolves the argument over everything', () => {
    const resolution = resolveDesktopHome([`--dsh-home=${ABSOLUTE}`], { DSH_HOME: ABSOLUTE_OTHER })
    expect(resolution).toEqual({ homeDir: resolveDshHome(ABSOLUTE), source: 'argument', configured: ABSOLUTE })
  })

  it('labels the environment layer', () => {
    const resolution = resolveDesktopHome([], { DSH_HOME: ABSOLUTE })
    expect(resolution).toEqual({ homeDir: resolveDshHome(undefined, { DSH_HOME: ABSOLUTE }), source: 'environment', configured: undefined })
  })

  it.each([
    ['an unset variable', {}],
    ['a blank variable', { DSH_HOME: '   ' }],
  ])('falls through to the official default with %s', (_name, env) => {
    const resolution = resolveDesktopHome([], env)
    expect(resolution).toEqual({ homeDir: resolveDshHome(undefined, env), source: 'default', configured: undefined })
  })
})

describe('same-source consumption', () => {
  it('puts the desktop paths under the resolved home', () => {
    const resolution = resolveDesktopHome([`--dsh-home=${ABSOLUTE}`], {})
    const paths = resolveDesktopPaths(resolution.configured)
    expect(paths.profile).toBe(join(resolution.homeDir, 'profiles', 'desktop'))
    expect(paths.lock).toBe(join(resolution.homeDir, 'profiles', 'desktop', 'lock'))
    expect(paths.profile.endsWith(`${sep}profiles${sep}desktop`)).toBe(true)
  })
})
