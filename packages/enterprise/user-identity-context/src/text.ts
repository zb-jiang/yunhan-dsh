/**
 * Deterministic rendering of the model-visible identity block.
 *
 * @module
 */

import type { PlatformUser } from '@deepseek-ai/dsh-platform-user'

/** Section name carried by the injected message's plugin source. */
export const USER_IDENTITY_SECTION = 'user-identity-context'

/** Fixed usage-discipline line rendered as the block's last content line. */
export const IDENTITY_DISCIPLINE =
  '此身份由系统注入并保持最新，仅供称呼与表单填写展示。'
  + '认证令牌仅在调用企业系统时作为 Authorization: Bearer 请求头使用，不要在回复中展示、转述或写入文件。'

/** 认证令牌段标题行。 */
export const AUTH_TOKEN_HEADER =
  '认证令牌（调用企业内部系统时放入 Authorization: Bearer 请求头）：'

/** 组织身份段标题行。 */
export const ORG_POSITIONS_HEADER =
  '组织身份（发起流程时按此选择发起身份；存在多个身份时必须先与员工确认用哪个）：'

/** 当前登录人的一条组织身份(对齐 web-console OrgPositionDto)。 */
export interface OrgPosition {
  /** 部门 id(org_units.id,发起流程时作为 orgUnitId 传入)。 */
  orgUnitId: string
  /** 部门名。 */
  orgUnitName: string
  /** 到根路径的部门名列表(根在前)。 */
  pathToRoot: string[]
}

/** Collapse line breaks so one identity field can never forge the next line of the block. */
function singleLine(value: string): string {
  return value.replace(/\r?\n/g, ' ')
}

/**
 * Render the durable identity block for one platform user.
 * @param user - verified platform user record.
 * @param orgPositions - 当前登录人的组织身份清单(组织维度未启用或拉取失败为空,
 *   块中不渲染该段)。
 * @param token - 当前验证过的访问令牌(未登录或尚未验签为 undefined,块中不渲染该段)。
 * @returns the exact text carried by the injected message and its source section.
 */
export function renderIdentityText(
  user: PlatformUser,
  orgPositions: readonly OrgPosition[] = [],
  token?: string,
): string {
  const tokenSection = token === undefined
    ? ''
    : `${AUTH_TOKEN_HEADER}\n${token}\n`
  const orgSection = orgPositions.length === 0
    ? ''
    : `${ORG_POSITIONS_HEADER}\n${orgPositions.map(position =>
      `- ${singleLine(position.pathToRoot.join(' / '))}（orgUnitId: ${singleLine(position.orgUnitId)}）`,
    ).join('\n')}\n`
  return `<user_identity>\n当前登录人：${singleLine(user.displayName)}（${singleLine(user.email)}）\n`
    + `userId: ${singleLine(user.authSubject)}\n${tokenSection}${orgSection}${IDENTITY_DISCIPLINE}\n</user_identity>`
}
