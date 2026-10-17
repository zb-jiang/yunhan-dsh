package com.dsh.console.instanceworkspace;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.instanceworkspace.dto.InstanceWorkspaceFileDto;
import com.dsh.console.instanceworkspace.dto.WriteTextRequest;
import com.dsh.console.security.AuthContext;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.StreamingResponseBody;

/**
 * 流程实例云工作空间员工面 API(设计 docs/plans/2026-10-14-instance-workspace-design.md §4.1)。
 *
 * <p>JWT 鉴权后按实例归属应用做成员校验(system_admin/应用管理员/active 成员);下载与导出
 * 返回精确 {@code ResponseEntity<StreamingResponseBody>}(通配符泛型会被流式处理器拒收),
 * zip 内条目用已校验 relPath,无路径逃逸。
 */
@RestController
@RequestMapping("/api/workspace/instances")
public class InstanceWorkspaceController {

    private final InstanceWorkspaceService service;

    public InstanceWorkspaceController(InstanceWorkspaceService service) {
        this.service = service;
    }

    /** 列实例空间全部文件(元数据快查;磁盘缺失的行以 diskMissing 标记)。 */
    @GetMapping("/{instanceId}/files")
    public ApiResponse<List<InstanceWorkspaceFileDto>> list(
        @AuthenticationPrincipal AuthContext auth, @PathVariable String instanceId) {
        return ApiResponse.ok(service.list(auth, instanceId));
    }

    /**
     * 下载单文件,流式回传磁盘内容。
     *
     * <p>PathPattern 的 capture-the-rest 语法 {@code {*relPath}} 捕获值带前导
     * {@code /}(如 {@code /a/b.txt}),剥掉后才是 validateRelPath 认可的相对路径。
     */
    @GetMapping("/{instanceId}/files/content/{*relPath}")
    public ResponseEntity<StreamingResponseBody> download(
        @AuthenticationPrincipal AuthContext auth,
        @PathVariable String instanceId,
        @PathVariable String relPath) {
        String normalized = relPath.replaceFirst("^/", "");
        InstanceWorkspaceService.DownloadPayload payload = service.download(auth, instanceId, normalized);
        String filename = normalized.substring(normalized.lastIndexOf('/') + 1);
        return fileResponse(payload, filename, out -> Files.copy(payload.diskPath(), out));
    }

    /** 导出实例空间全部文件为 zip,流式打包(不整载内存)。 */
    @GetMapping("/{instanceId}/files/export")
    public ResponseEntity<StreamingResponseBody> exportZip(
        @AuthenticationPrincipal AuthContext auth,
        @PathVariable String instanceId) {
        String filename = "instance-" + instanceId + "-workspace.zip";
        HttpHeaders headers = new HttpHeaders();
        headers.setContentDisposition(ContentDisposition.attachment()
            .filename(filename, StandardCharsets.UTF_8).build());
        headers.setContentType(MediaType.parseMediaType("application/zip"));
        StreamingResponseBody body = out -> service.exportTo(auth, instanceId, out);
        return ResponseEntity.ok().headers(headers).body(body);
    }

    /** 上传/覆盖字节文件(multipart;同 relPath 为覆盖,后写者胜)。 */
    @PostMapping(value = "/{instanceId}/files", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<InstanceWorkspaceFileDto> upload(
        @AuthenticationPrincipal AuthContext auth,
        @PathVariable String instanceId,
        @RequestParam("path") String path,
        @RequestPart("file") MultipartFile file) {
        return ApiResponse.ok(service.upload(auth, instanceId, path, file));
    }

    /** 写/覆盖文本文件(UTF-8;content 允许空串,落 0 字节文件)。 */
    @PostMapping("/{instanceId}/files/text")
    public ApiResponse<InstanceWorkspaceFileDto> writeText(
        @AuthenticationPrincipal AuthContext auth,
        @PathVariable String instanceId,
        @RequestBody WriteTextRequest body) {
        return ApiResponse.ok(service.writeText(auth, instanceId, body));
    }

    /** 删除单文件(先删行再删盘;行不存在或磁盘缺失均 404);capture-the-rest 捕获值剥前导 /。 */
    @DeleteMapping("/{instanceId}/files/content/{*relPath}")
    public ApiResponse<Void> delete(
        @AuthenticationPrincipal AuthContext auth,
        @PathVariable String instanceId,
        @PathVariable String relPath) {
        service.delete(auth, instanceId, relPath.replaceFirst("^/", ""));
        return ApiResponse.ok(null);
    }

    private static ResponseEntity<StreamingResponseBody> fileResponse(
        InstanceWorkspaceService.DownloadPayload payload, String filename,
        StreamingResponseBody body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentDisposition(ContentDisposition.attachment()
            .filename(filename, StandardCharsets.UTF_8).build());
        headers.setContentType(payload.row().contentType() != null
            ? MediaType.parseMediaType(payload.row().contentType())
            : MediaType.APPLICATION_OCTET_STREAM);
        return ResponseEntity.ok().headers(headers).body(body);
    }
}
