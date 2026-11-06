/**
 * Python 环境检测(设计 2026-11-04 §5.5):解释器版本 3.10–3.14 与
 * ppt-master 核心依赖就绪与否。命令执行通过 {@link CommandRunner} 注入,
 * 检测逻辑本身保持可测;runner 抛错视为探测失败,不进程崩溃。
 *
 * @module
 */

import { execFile } from 'node:child_process'

/** 命令执行器抽象,生产实现见 {@link nodeCommandRunner},测试注入桩。 */
export type CommandRunner = (command: string, args: string[]) => Promise<CommandOutcome>

/** 一次命令执行的结果。 */
export interface CommandOutcome {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * 候选解释器链。Windows 常见的 `python3` 是 Store 占位 stub(9009 无输出),
 * 只探测 `python`;函数形式使 detectPython 的候选链随运行时平台求值、可测。
 *
 * @param platform - 运行时平台取值(即 `process.platform`)。
 * @returns 按平台求值的候选解释器命令名,按序探测。
 */
export function pythonCandidates(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['python'] : ['python', 'python3']
}

/** ppt-master 生成 PPTX 的最小依赖集(requirements.txt 的核心子集)。 */
export const CORE_PACKAGES = ['python-pptx', 'PyYAML', 'XlsxWriter', 'skia-pathops', 'uharfbuzz', 'Pillow', 'numpy', 'requests'] as const

/** 单个解释器候选的探测结果。 */
export interface PythonDetection {
  available: boolean
  /** 探测成功的命令名(`python`/`python3`)。 */
  pythonCmd?: string
  /** `Python x.y.z` 的版本文本。 */
  version?: string
  /** 版本是否落在 3.10–3.14。 */
  versionOk: boolean
}

/** 依赖包就绪状态。 */
export interface DependencyCheck {
  name: string
  installed: boolean
}

/** `/api/ppt/python-status` 的响应体。 */
export interface PythonStatus {
  python: PythonDetection
  dependencies: DependencyCheck[]
  /** 解释器可用且版本合规且核心依赖齐备。 */
  ready: boolean
}

/** runner 失败(ENOENT 等)折算成一次非零退出,检测流程统一走结果值。 */
async function runOnce(runner: CommandRunner, command: string, args: string[]): Promise<CommandOutcome> {
  try {
    return await runner(command, args)
  } catch {
    return { exitCode: -1, stdout: '', stderr: 'spawn failed' }
  }
}

/**
 * 从 `python --version` 输出提取 `x.y.z`;不匹配返回 undefined。
 * @param output - 候选命令的 stdout 与 stderr 合并文本(Windows 把版本写到 stderr)。
 * @returns 版本号文本 `x.y.z`;输出不匹配时为 undefined。
 */
export function parsePythonVersion(output: string): string | undefined {
  const match = /Python (\d+\.\d+\.\d+)/.exec(output)
  return match?.[1]
}

/** 支持的版本区间:3.10(含)–3.14(含)。 */
const MIN_MINOR = 10
const MAX_MINOR = 14

/**
 * 版本是否落在 3.10–3.14(含端点)。
 * @param version - {@link parsePythonVersion} 提取的版本号文本。
 * @returns 主版本为 3 且次版本在区间内时 true;格式不合法返回 false。
 */
export function isSupportedVersion(version: string): boolean {
  const parts = version.split('.').map(part => Number(part))
  if (parts.length < 2 || parts.some(part => Number.isNaN(part))) return false
  const [major, minor] = parts as [number, number]
  if (major !== 3) return false
  return minor >= MIN_MINOR && minor <= MAX_MINOR
}

/**
 * 探测候选解释器;全部失败回「不可用」。
 * @param runner - 命令执行器,抛错按探测失败折算。
 * @returns 第一个能报出版本号的候选的探测结果;全部候选失败返回 `available: false`。
 */
export async function detectPython(runner: CommandRunner): Promise<PythonDetection> {
  for (const pythonCmd of pythonCandidates(process.platform)) {
    const outcome = await runOnce(runner, pythonCmd, ['--version'])
    const version = parsePythonVersion(outcome.stdout + outcome.stderr)
    if (version === undefined) continue
    return { available: true, pythonCmd, version, versionOk: isSupportedVersion(version) }
  }
  return { available: false, versionOk: false }
}

/**
 * 逐包 `pip show` 探测就绪状态(并行)。
 * @param runner - 命令执行器。
 * @param pythonCmd - 解释器命令名,来自探测成功的候选。
 * @param packages - 待探测的包名;缺省为核心依赖集 {@link CORE_PACKAGES}。
 * @returns 逐包就绪状态,顺序与入参一致;命令失败按未安装计。
 */
export async function checkDependencies(
  runner: CommandRunner,
  pythonCmd: string,
  packages: readonly string[] = CORE_PACKAGES,
): Promise<DependencyCheck[]> {
  return Promise.all(packages.map(async name => ({
    name,
    installed: (await runOnce(runner, pythonCmd, ['-m', 'pip', 'show', name])).exitCode === 0,
  })))
}

/**
 * 组合检测:解释器 + 依赖;解释器不可用时依赖清单为逐包未装。
 * @param runner - 命令执行器。
 * @returns 解释器与依赖的组合状态;`ready` 仅在解释器可用、版本合规且核心依赖齐备时为 true。
 */
export async function pythonStatus(runner: CommandRunner): Promise<PythonStatus> {
  const python = await detectPython(runner)
  const dependencies = python.available
    ? await checkDependencies(runner, python.pythonCmd ?? 'python')
    : CORE_PACKAGES.map(name => ({ name, installed: false }))
  return { python, dependencies, ready: python.available && python.versionOk && dependencies.every(dep => dep.installed) }
}

/**
 * 生产 runner:`execFile` 包装;15s 超时防 pip 卡死,输出上限 1MB。
 * @returns 基于 `execFile` 的命令执行器;失败/超时折算为非零 `exitCode`,不抛错。
 */
export function nodeCommandRunner(): CommandRunner {
  return (command, args) => new Promise((resolve) => {
    execFile(command, args, { maxBuffer: 1024 * 1024, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ exitCode: 0, stdout, stderr })
        return
      }
      const code = (error as NodeJS.ErrnoException).code
      resolve({ exitCode: typeof code === 'number' ? code : 1, stdout, stderr })
    })
  })
}
