package com.dsh.console.security;

import static org.assertj.core.api.Assertions.assertThat;

import com.dsh.console.config.ServiceKeyProperties;
import jakarta.servlet.ServletException;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.core.context.SecurityContextImpl;

/**
 * {@link ServiceKeyAuthFilter} 白名单语义:密钥+GET+白名单路径三条同时成立才注入
 * 服务身份(以 kb/**、org/** 条目为样本);任何一条不满足都 401;无头请求原样放行
 * 走 JWT 链。
 */
class ServiceKeyAuthFilterTest {

    private static final String KEY = "sk-test-1";

    private ServiceKeyAuthFilter filter;

    @BeforeEach
    void setUp() {
        filter = new ServiceKeyAuthFilter(new ServiceKeyProperties(KEY));
        SecurityContextHolder.setContext(new SecurityContextImpl());
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    private MockHttpServletRequest request(String method, String uri, String header) {
        MockHttpServletRequest request = new MockHttpServletRequest(method, uri);
        if (header != null) {
            request.addHeader(ServiceKeyAuthFilter.HEADER, header);
        }
        return request;
    }

    @Test
    void requestWithoutHeaderPassesThroughUnauthenticated() throws ServletException, IOException {
        MockHttpServletRequest request = request("GET", "/api/expenses", null);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(chain.getRequest()).isNotNull();
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    }

    @Test
    void validKeyOnWhitelistedPathInjectsServiceAuthentication() throws ServletException, IOException {
        MockHttpServletRequest request = request("GET", "/api/backend/kb/resolve?processDefinitionId=x", KEY);
        MockHttpServletResponse response = new MockHttpServletResponse();
        // 服务身份只在链内可见:过滤器 finally 清 context 防线程池复用泄漏,链外读必为空
        AtomicReference<Authentication> captured = new AtomicReference<>();

        filter.doFilter(request, response, (req, res) ->
            captured.set(SecurityContextHolder.getContext().getAuthentication()));

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(captured.get()).isNotNull();
        assertThat(captured.get().getPrincipal()).isEqualTo("dsh-service");
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    }

    @Test
    void wrongKeyIsRejectedWith401() throws ServletException, IOException {
        MockHttpServletRequest request = request("GET", "/api/backend/kb/resolve", "sk-wrong");
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertThat(response.getStatus()).isEqualTo(401);
    }

    @Test
    void keyOnNonWhitelistedPathIsRejectedWith401() throws ServletException, IOException {
        MockHttpServletRequest request = request("GET", "/api/kb/documents", KEY);
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertThat(response.getStatus()).isEqualTo(401);
    }

    @Test
    void keyOnNonGetMethodIsRejectedWith401() throws ServletException, IOException {
        MockHttpServletRequest request = request("POST", "/api/backend/kb/resolve", KEY);
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertThat(response.getStatus()).isEqualTo(401);
    }

    @Test
    void anyKeyIsRejectedWhenMechanismDisabled() throws ServletException, IOException {
        filter = new ServiceKeyAuthFilter(new ServiceKeyProperties(""));
        MockHttpServletRequest request = request("GET", "/api/backend/kb/resolve", KEY);
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertThat(response.getStatus()).isEqualTo(401);
    }

    @Test
    void validKeyOnOrgPathInjectsServiceAuthentication() throws ServletException, IOException {
        MockHttpServletRequest request = request("GET", "/api/backend/org/units", KEY);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicReference<Authentication> captured = new AtomicReference<>();

        filter.doFilter(request, response, (req, res) ->
            captured.set(SecurityContextHolder.getContext().getAuthentication()));

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(captured.get()).isNotNull();
        assertThat(captured.get().getPrincipal()).isEqualTo("dsh-service");
    }

    @Test
    void validKeyOnOrgMembersPathInjectsServiceAuthentication() throws ServletException, IOException {
        MockHttpServletRequest request =
            request("GET", "/api/backend/org/units/" + UUID.randomUUID() + "/members", KEY);
        MockHttpServletResponse response = new MockHttpServletResponse();
        AtomicReference<Authentication> captured = new AtomicReference<>();

        filter.doFilter(request, response, (req, res) ->
            captured.set(SecurityContextHolder.getContext().getAuthentication()));

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(captured.get()).isNotNull();
    }

    @Test
    void validKeyOnOrgWriteMethodIsRejectedWith401() throws ServletException, IOException {
        MockHttpServletRequest request = request("POST", "/api/backend/org/units", KEY);
        MockHttpServletResponse response = new MockHttpServletResponse();

        filter.doFilter(request, response, new MockFilterChain());

        assertThat(response.getStatus()).isEqualTo(401);
    }
}
