/** Check shipped-language coverage of package metadata and plugin templates without loading plugins. */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { basename, posix, join, resolve } from 'node:path'
import { detailPath } from '../packages/util/plugin-detail/src/document.ts'
import { PRODUCT_PACKAGE_POLICY } from './product-package-policy.ts'
import { SHIPPED_LOCALE_IDS, localeTokens, hasInvisibleLocaleCharacters } from './shipped-locales.ts'
import { collectConfigCatalog } from './gen-config-catalog.ts'

/** Flatten metadata strings and reject values that cannot be translated. */
function strings(value: unknown, key = ''): Record<string, string> {
  if (typeof value === 'string' && value.trim() !== '') return { [key]: value }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${key}: expected non-empty text`)
  return Object.fromEntries(Object.entries(value).flatMap(([name, child]) => Object.entries(strings(child, key ? `${key}.${name}` : name))))
}

/**
 * 企业偏离:企业定制包与内部 PPT 插件不经插件市场分发，产品语言覆盖由部署需求决定，
 * 不强制 locale 目录与全套 shipped 语言；上游 CI 不含企业包，此清单仅企业分支维护。
 */
const LOCALE_EXEMPT_PACKAGES = new Set([
  'packages/client/ui-enterprise',
  'packages/client/ui-enterprise-skills',
  'packages/client/ui-settings-global-rules',
  'packages/enterprise/backend-task',
  'packages/enterprise/file-write',
  'packages/enterprise/flowable-task-proxy',
  'packages/enterprise/instance-workspace',
  'packages/enterprise/kb-context',
  'packages/enterprise/knowledge',
  'packages/enterprise/llm-access',
  'packages/enterprise/platform-user',
  'packages/enterprise/platform-user-api',
  'packages/enterprise/platform-user-console',
  'packages/enterprise/pocket-access',
  'packages/enterprise/process-start',
  'packages/enterprise/session-delete',
  'packages/enterprise/skill-sync',
  'packages/enterprise/user-identity-context',
  'packages/plugins/ppt-client',
  'packages/plugins/ppt-core',
])

/**
 * Compare shipped-language metadata with every field supplied by English or Chinese.
 * @param root - repository or fixture root.
 * @returns actionable missing-file, field, placeholder and resource diagnostics.
 */
export function localeMetadataProblems(root: string): string[] {
  const directories = new Set(globSync('packages/**/locale/**/*.json', {
    cwd: root, exclude: ['packages/**/node_modules/**', 'packages/**/lib/**', 'packages/**/tests/**'],
  }).map(file => file.replaceAll('\\', '/')).filter(file => SHIPPED_LOCALE_IDS.some(language => basename(file) === `${language}.json`)).map(file => posix.dirname(file))
    .filter(directory => !LOCALE_EXEMPT_PACKAGES.has(directory.slice(0, -'/locale'.length))))
  for (const entry of collectConfigCatalog(root)) {
    const dir = entry.dir.replaceAll('\\', '/')
    if (PRODUCT_PACKAGE_POLICY[dir]?.category === 'test') continue
    if (LOCALE_EXEMPT_PACKAGES.has(dir)) continue
    if (entry.kind !== 'config' && entry.kind !== 'no-config') continue
    const directory = `${dir}/locale`
    directories.add(directory)
  }
  const problems: string[] = []
  if (directories.size === 0) return ['no package locale metadata found']
  for (const directory of [...directories].sort()) {
    try {
      const read = (language: string): Record<string, string> => {
        const file = join(root, directory, `${language}.json`)
        const source = readFileSync(file, 'utf8')
        if (hasInvisibleLocaleCharacters(source) || /\\u(?:200b|feff)/iu.test(source)) throw new Error(`${language}.json: invisible locale character`)
        const value: unknown = JSON.parse(source)
        const dictionary = strings(value)
        const detail = detailPath(dictionary['meta.detail'], `${directory}/${language}.json: meta.detail`)
        const packageDir = directory.slice(0, directory.lastIndexOf('/locale'))
        if (detail !== undefined && !existsSync(resolve(root, packageDir, detail))) {
          throw new Error(`missing detail resource ${detail}`)
        }
        return dictionary
      }
      const en = read('en')
      const zh = existsSync(join(root, directory, 'zh.json')) ? read('zh') : {}
      const description = en['meta.description']
      if (description !== undefined && !/[.!?]$/u.test(description)) problems.push(`${directory}/en.json: meta.description must end with sentence punctuation`)
      const expected = { ...zh, ...en }
      for (const language of SHIPPED_LOCALE_IDS.filter(id => id !== 'en' && id !== 'zh')) {
        const translated = read(language)
        for (const key of new Set([...Object.keys(expected), ...Object.keys(translated)])) {
          if (translated[key] === undefined) problems.push(`${directory}/${language}.json: missing ${key}`)
          else if (expected[key] === undefined) problems.push(`${directory}/${language}.json: unexpected ${key}`)
          else {
            if (language !== 'ja' && key === 'meta.description' && ((zh[key] !== undefined && /\p{Script=Han}/u.test(zh[key]) && translated[key] === zh[key])
              || (en[key] !== undefined && translated[key] === en[key]))) {
              problems.push(`${directory}/${language}.json: ${key} contains untranslated source text`)
            }
            const placeholders = (text: string): string => localeTokens(text).join(',')
            if (placeholders(translated[key]) !== placeholders(expected[key])) problems.push(`${directory}/${language}.json: ${key} changes placeholders or literal tokens`)
          }
        }
      }
    } catch (error) {
      problems.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return problems
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const problems = localeMetadataProblems(resolve(import.meta.dirname, '..'))
  for (const problem of problems) console.error(problem)
  if (problems.length > 0) process.exitCode = 1
  else console.log('verify-locale-metadata: all package and template metadata has complete shipped-language translations.')
}
