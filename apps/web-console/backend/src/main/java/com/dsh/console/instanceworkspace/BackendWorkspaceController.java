package com.dsh.console.instanceworkspace;

import com.dsh.console.common.ApiResponse;
import com.dsh.console.instanceworkspace.dto.InstanceWorkspaceFileDto;
import com.dsh.console.instanceworkspace.dto.WriteTextRequest;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
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
 * 流程实例云工作空间服务面 API(设计 docs/plans/2026-10-14-instance-workspace-design.md §4.2),
 * 供员工端 DSH 插件与 backend profile 工具经本地 webserver 代理调用。
 *
 * <p>鉴权走 {@code X-Service-Key}({@code ServiceKeyAuthFilter} 白名单条目
 * {@code /api/backend/instances/} 放行 GET/POST/DELETE),服务密钥即信任边界,
 * 不做应用成员校验;无元数据行的读直接空列表/404,写仍解析实例归属以构造磁盘路径。
 */
@RestController
@RequestMapping("/api/backend/instances")
public class BackendWorkspaceController {

    private final InstanceWorkspaceService service;

    public BackendWorkspaceController(InstanceWorkspaceService service) {
        this.service = service;
    }

    /** 列实例空间全部文件;无元数据行直接空列表,不访问引擎。 */
    @GetMapping("/{instanceId}/files")
    public ApiResponse<List<InstanceWorkspaceFileDto>> list(@PathVariable String instanceId) {
        return ApiResponse.ok(service.listForService(instanceId));
    }

    /**
     * 下载单文件;行不存在或磁盘缺失直接 404,不解析归属。
     *
     * <p>PathPattern capture-the-rest({@code {*relPath}})捕获值带前导 {@code /},剥掉后即相对路径。
     */
    @GetMapping("/{instanceId}/files/content/{*relPath}")
    public ResponseEntity<StreamingResponseBody> download(
        @PathVariable String instanceId,
        @PathVariable String relPath) {
        String normalized = relPath.replaceFirst("^/", "");
        InstanceWorkspaceService.DownloadPayload payload =
            service.downloadForService(instanceId, normalized);
        String filename = normalized.substring(normalized.lastIndexOf('/') + 1);
        HttpHeaders headers = new HttpHeaders();
        headers.setContentDisposition(ContentDisposition.attachment()
            .filename(filename, StandardCharsets.UTF_8).build());
        headers.setContentType(payload.row().contentType() != null
            ? MediaType.parseMediaType(payload.row().contentType())
            : MediaType.APPLICATION_OCTET_STREAM);
        StreamingResponseBody body = out -> Files.copy(payload.diskPath(), out);
        return ResponseEntity.ok().headers(headers).body(body);
    }

    /** 上传/覆盖字节文件(multipart);uploaded_by 固定 dsh-service。 */
    @PostMapping(value = "/{instanceId}/files", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ApiResponse<InstanceWorkspaceFileDto> upload(
        @PathVariable String instanceId,
        @RequestParam("path") String path,
        @RequestPart("file") MultipartFile file) {
        return ApiResponse.ok(service.uploadForService(instanceId, path, file));
    }

    /** 写/覆盖文本文件(UTF-8);uploaded_by 固定 dsh-service。 */
    @PostMapping("/{instanceId}/files/text")
    public ApiResponse<InstanceWorkspaceFileDto> writeText(
        @PathVariable String instanceId,
        @RequestBody WriteTextRequest body) {
        return ApiResponse.ok(service.writeTextForService(instanceId, body));
    }

    /** 删除单文件;行不存在直接 404,不解析归属;capture-the-rest 捕获值剥前导 /。 */
    @DeleteMapping("/{instanceId}/files/content/{*relPath}")
    public ApiResponse<Void> delete(
        @PathVariable String instanceId,
        @PathVariable String relPath) {
        service.deleteForService(instanceId, relPath.replaceFirst("^/", ""));
        return ApiResponse.ok(null);
    }
}
