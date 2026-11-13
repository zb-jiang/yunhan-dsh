package com.dsh.console.orgunit;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.orgunit.dto.BackendOrgUnitMemberDto;
import com.dsh.console.orgunit.dto.OrgUnitTreeNode;
import java.util.List;
import java.util.UUID;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 组织架构只读端点(X-Service-Key 服务身份,外部 SOR 系统服务器间消费;
 * 当前调用方:OpenMAIC 课程分派页读组织树与部门成员派课)。
 *
 * <p>鉴权不走员工 JWT:由 {@code ServiceKeyAuthFilter} 的白名单
 * {@code GET /api/backend/org/**} 放行,控制器不使用 {@code @AuthenticationPrincipal}。
 * 只读语义:业务复用 {@link OrgUnitService},员工端 {@code /api/org-units*}
 * 路由的行为与权限不受影响;成员明细的服务面变体仅多 {@code authSubject}
 * 一列(platform_users.auth_subject,员工 JWT sub 同源),调用方按
 * (issuer, subject) 建档即可完成「成员 → SOR 用户」映射,免读 platform_users。
 */
@RestController
@RequestMapping("/api/backend/org")
public class BackendOrgController {

    private final OrgUnitService orgUnitService;

    public BackendOrgController(OrgUnitService orgUnitService) {
        this.orgUnitService = orgUnitService;
    }

    /** 部门树(嵌套 children,含负责人),响应形状同员工端 {@code GET /api/org-units}。 */
    @GetMapping("/units")
    public ApiResponse<List<OrgUnitTreeNode>> tree() {
        return ApiResponse.ok(orgUnitService.tree());
    }

    /**
     * 部门成员明细(userId/authSubject 并列),响应形状同员工端
     * {@code GET /api/org-units/{orgUnitId}/members} 增列 authSubject;
     * 部门不存在 → 404。
     */
    @GetMapping("/units/{orgUnitId}/members")
    public ApiResponse<List<BackendOrgUnitMemberDto>> members(@PathVariable UUID orgUnitId) {
        return ApiResponse.ok(orgUnitService.membersForService(orgUnitId));
    }
}
