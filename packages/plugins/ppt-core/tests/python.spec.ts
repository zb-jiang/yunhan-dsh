import { describe, expect, it } from 'vitest'
import { checkDependencies, CORE_PACKAGES, detectPython, isSupportedVersion, nodeCommandRunner, parsePythonVersion, pythonStatus, type CommandOutcome, type CommandRunner } from '../src/python.ts'

/** 固定应答桩:按命令名+首参查表,未命中回非零退出。 */
function runnerOf(table: Record<string, CommandOutcome>): CommandRunner {
  return async (command, args) => {
    const outcome = table[`${command} ${args.join(' ')}`]
    if (outcome === undefined) return { exitCode: 1, stdout: '', stderr: 'unexpected command' }
    return outcome
  }
}

describe('parsePythonVersion', () => {
  it('从标准输出提取 x.y.z', () => {
    expect(parsePythonVersion('Python 3.12.4')).toBe('3.12.4')
  })

  it('stderr 里的版本也认(Windows python --version 走 stderr)', () => {
    expect(parsePythonVersion('Python 3.11.9')).toBe('3.11.9')
  })

  it('不匹配回 undefined', () => {
    expect(parsePythonVersion('no version here')).toBeUndefined()
  })
})

describe('isSupportedVersion', () => {
  it('3.10–3.14 含端点', () => {
    expect(isSupportedVersion('3.9.7')).toBe(false)
    expect(isSupportedVersion('3.10.0')).toBe(true)
    expect(isSupportedVersion('3.14.0')).toBe(true)
    expect(isSupportedVersion('3.15.1')).toBe(false)
    expect(isSupportedVersion('4.0.0')).toBe(false)
  })

  it('残缺版本拒绝', () => {
    expect(isSupportedVersion('3')).toBe(false)
    expect(isSupportedVersion('a.b.c')).toBe(false)
  })
})

describe('detectPython', () => {
  it('候选命中即返回全量探测结果', async () => {
    const detection = await detectPython(runnerOf({ 'python --version': { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } }))
    expect(detection).toEqual({ available: true, pythonCmd: 'python', version: '3.12.1', versionOk: true })
  })

  it('版本输出缺版本文本时继续探下一个候选(非 Windows 候选链)', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      const detection = await detectPython(runnerOf({
        'python --version': { exitCode: 0, stdout: 'stub', stderr: '' },
        'python3 --version': { exitCode: 0, stdout: 'Python 3.13.2', stderr: '' },
      }))
      expect(detection).toEqual({ available: true, pythonCmd: 'python3', version: '3.13.2', versionOk: true })
    } finally {
      if (platformDescriptor !== undefined) Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it('全部失败回不可用', async () => {
    const detection = await detectPython(runnerOf({}))
    expect(detection).toEqual({ available: false, versionOk: false })
  })
})

describe('checkDependencies', () => {
  it('pip show 退出码 0 视为已装', async () => {
    const table: Record<string, CommandOutcome> = {}
    for (const name of CORE_PACKAGES) table[`python -m pip show ${name}`] = { exitCode: 0, stdout: 'ok', stderr: '' }
    table['python -m pip show numpy'] = { exitCode: 1, stdout: '', stderr: 'not found' }
    const result = await checkDependencies(runnerOf(table), 'python')
    expect(result).toHaveLength(CORE_PACKAGES.length)
    expect(result.find(dep => dep.name === 'numpy')?.installed).toBe(false)
    expect(result.filter(dep => dep.installed)).toHaveLength(CORE_PACKAGES.length - 1)
  })
})

describe('pythonStatus', () => {
  it('解释器可用且依赖齐备 → ready', async () => {
    const table: Record<string, CommandOutcome> = { 'python --version': { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } }
    for (const name of CORE_PACKAGES) table[`python -m pip show ${name}`] = { exitCode: 0, stdout: 'ok', stderr: '' }
    const status = await pythonStatus(runnerOf(table))
    expect(status.ready).toBe(true)
    expect(status.python.pythonCmd).toBe('python')
  })

  it('版本不合规 → ready 为假', async () => {
    const table: Record<string, CommandOutcome> = { 'python --version': { exitCode: 0, stdout: 'Python 3.9.1', stderr: '' } }
    for (const name of CORE_PACKAGES) table[`python -m pip show ${name}`] = { exitCode: 0, stdout: 'ok', stderr: '' }
    expect((await pythonStatus(runnerOf(table))).ready).toBe(false)
  })

  it('缺包 → ready 为假', async () => {
    const table: Record<string, CommandOutcome> = { 'python --version': { exitCode: 0, stdout: 'Python 3.12.1', stderr: '' } }
    const status = await pythonStatus(runnerOf(table))
    expect(status.ready).toBe(false)
    expect(status.dependencies.every(dep => !dep.installed)).toBe(true)
  })

  it('解释器不可用时依赖清单逐包未装且不探测 pip', async () => {
    const status = await pythonStatus(runnerOf({}))
    expect(status.ready).toBe(false)
    expect(status.dependencies).toEqual(CORE_PACKAGES.map(name => ({ name, installed: false })))
  })
})

describe('nodeCommandRunner', () => {
  const runner = nodeCommandRunner()

  it('成功命令回退出码 0 与输出', async () => {
    const outcome = await runner(process.execPath, ['-e', 'console.log("ok")'])
    expect(outcome.exitCode).toBe(0)
    expect(outcome.stdout).toContain('ok')
  })

  it('非零退出折算 exitCode', async () => {
    const outcome = await runner(process.execPath, ['-e', 'process.exit(3)'])
    expect(outcome.exitCode).toBe(3)
  })

  it('命令不存在时回退出码 1 而不抛错', async () => {
    const outcome = await runner('definitely-not-a-command-xyz', [])
    expect(outcome.exitCode).toBe(1)
  })
})
