package com.dsh.console.orgunit.dto;

import java.util.UUID;

/**
 * 部门成员明细(服务面变体):员工端 {@link OrgUnitMemberDto} 增列 {@code authSubject},
 * 仅经 X-Service-Key 服务面端点(BackendOrgController)下发,员工端不暴露。
 *
 * @param userId      platform_users.id
 * @param loginName   登录名
 * @param displayName 显示名
 * @param status      账号状态
 * @param authSubject platform_users.auth_subject(员工 JWT sub 同源);调用方按
 *                    (issuer, subject) 建档映射成员,免读 platform_users
 */
public record BackendOrgUnitMemberDto(
    UUID userId,
    String loginName,
    String displayName,
    String status,
    String authSubject
) {
}
