package com.dsh.console.config;

import java.nio.charset.StandardCharsets;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.client.ClientHttpRequestInterceptor;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.http.converter.StringHttpMessageConverter;
import org.springframework.web.client.RestClient;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * RestClient 配置:调用 Flowable 引擎 REST、企业 Skill 仓库(SkillHub)与 Supabase Storage。
 *
 * <p>认证模型为"认证直连 Supabase"(参见 SPEC §7.2 与 Supabase 手册 §0):
 * <ul>
 *   <li>用户调 Web Console 时带 {@code Authorization: Bearer <supabase jwt>},Web Console 后端
 *       用 Supabase JWT Secret 本地验证(见 {@code SecurityConfig})。</li>
 *   <li>Web Console 调 Flowable REST 时把当前请求的 JWT 透传过去;Flowable 引擎同样用
 *       Supabase JWT Secret 验证,无需 server-to-server 共享密钥或 basic auth。</li>
 *   <li>Supabase Storage 同理:知识库上传/下载/删除透传用户 JWT(RLS 按应用成员放行),
 *       另带 {@code apikey: <anon key>} 头,不引入 service_role。</li>
 * </ul>
 *
 * <p>因此本配置不引入 {@code BasicAuthenticationInterceptor},仅在出站请求上补 Authorization 头。
 * 超时 30 秒;V1 单企业单实例够用,后续可换 HttpComponents client 支持连接池。
 *
 * <p>线程边界:本 bean 是单例,interceptor 通过 {@link RequestContextHolder} 拿当前线程
 * 绑定的请求;后台线程(如异步任务)无请求上下文时,interceptor 不补头,由调用方自行处理。
 * Storage 客户端只在请求线程调用(解析管线直接消费上传字节,不经 Storage 回读)。
 *
 * <p>SkillHub 客户端不同:浏览器不直连 SkillHub,后端持只读静态 Bearer token 代理访问
 * (token 在 {@link com.dsh.console.skillhub.SkillHubRestClient} 按请求设置,不走透传 interceptor)。
 */
@Configuration
public class RestClientConfig {

    private final FlowableRestProperties properties;
    private final SkillHubProperties skillHubProperties;
    private final KnowledgeProperties knowledgeProperties;

    public RestClientConfig(FlowableRestProperties properties,
                            SkillHubProperties skillHubProperties,
                            KnowledgeProperties knowledgeProperties) {
        this.properties = properties;
        this.skillHubProperties = skillHubProperties;
        this.knowledgeProperties = knowledgeProperties;
    }

    /**
     * Flowable REST 客户端:base URL + 透传 JWT + 10s/30s 超时。
     */
    @Bean
    public RestClient flowableRestClient() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(10_000);   // 10 秒
        factory.setReadTimeout(30_000);      // 30 秒
        return RestClient.builder()
            .baseUrl(properties.baseUrl())
            .requestFactory(factory)
            .requestInterceptor(forwardAuthHeader())
            .messageConverters(converters -> {
                converters.removeIf(c -> c instanceof StringHttpMessageConverter);
                converters.add(0, new StringHttpMessageConverter(StandardCharsets.UTF_8));
            })
            .build();
    }

    /**
     * SkillHub REST 客户端:base URL + 10s/30s 超时 + UTF-8,不带透传 interceptor
     * (静态 Bearer token 由 {@code SkillHubRestClient} 按请求设置)。
     */
    @Bean
    public RestClient skillHubRestClient() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(10_000);   // 10 秒
        factory.setReadTimeout(30_000);      // 30 秒
        return RestClient.builder()
            .baseUrl(skillHubProperties.baseUrl())
            .requestFactory(factory)
            .messageConverters(converters -> {
                converters.removeIf(c -> c instanceof StringHttpMessageConverter);
                converters.add(0, new StringHttpMessageConverter(StandardCharsets.UTF_8));
            })
            .build();
    }

    /**
     * Supabase Storage REST 客户端:base URL + 透传 JWT + 静态 apikey(anon key)头。
     *
     * <p>只服务知识库模块的上传/下载/删除,全部发生在请求线程
     * (解析管线直接消费上传字节,不经 Storage 回读),透传 interceptor 可靠。
     */
    @Bean
    public RestClient supabaseStorageRestClient() {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(10_000);   // 10 秒
        factory.setReadTimeout(60_000);      // 60 秒:50MB 文档上传留余量
        return RestClient.builder()
            .baseUrl(knowledgeProperties.supabaseUrl())
            .requestFactory(factory)
            .requestInterceptor(forwardAuthHeader())
            .defaultHeader("apikey", knowledgeProperties.anonKey())
            .messageConverters(converters -> {
                converters.removeIf(c -> c instanceof StringHttpMessageConverter);
                converters.add(0, new StringHttpMessageConverter(StandardCharsets.UTF_8));
            })
            .build();
    }

    /**
     * 透传当前请求的 Authorization 与 X-Service-Key 头给 Flowable 引擎。
     *
     * <p>Authorization 供管理面(JWT 用户)链路;X-Service-Key 供服务面
     * (backend profile / backend-task 工具,ServiceKeyAuthFilter 放行)链路——
     * 这类请求没有用户 JWT,引擎侧按共享服务密钥放行(引擎 SecurityConfig
     * 服务密钥 filter)。无请求上下文(异步线程、定时任务)时不补头,由调用方
     * 负责自行注入。
     */
    private ClientHttpRequestInterceptor forwardAuthHeader() {
        return (request, body, execution) -> {
            ServletRequestAttributes attrs =
                (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
            if (attrs != null) {
                String auth = attrs.getRequest().getHeader(HttpHeaders.AUTHORIZATION);
                if (auth != null && !auth.isBlank()) {
                    request.getHeaders().set(HttpHeaders.AUTHORIZATION, auth);
                }
                String serviceKey = attrs.getRequest().getHeader("X-Service-Key");
                if (serviceKey != null && !serviceKey.isBlank()) {
                    request.getHeaders().set("X-Service-Key", serviceKey);
                }
            }
            return execution.execute(request, body);
        };
    }
}
