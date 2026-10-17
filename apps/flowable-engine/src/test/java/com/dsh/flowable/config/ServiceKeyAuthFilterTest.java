package com.dsh.flowable.config;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
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
 * {@link ServiceKeyAuthFilter} 服务密钥通道语义:头与配置密钥一致才注入服务身份;
 * 不匹配、缺失、密钥未配置时一律不设认证(落到 JWT 通道或被 401 拒绝,fail-closed)。
 */
class ServiceKeyAuthFilterTest {

    private static final String KEY = "sk-test-1";

    private ServiceKeyAuthFilter filter;

    @BeforeEach
    void setUp() {
        filter = new ServiceKeyAuthFilter(new DshWebConsoleProperties("http://console:8080", KEY));
        SecurityContextHolder.setContext(new SecurityContextImpl());
    }

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    private MockHttpServletRequest request(String header) {
        MockHttpServletRequest request = new MockHttpServletRequest("GET", "/process-api/runtime/process-instances");
        if (header != null) {
            request.addHeader(ServiceKeyAuthFilter.HEADER, header);
        }
        return request;
    }

    @Test
    void matchingKeyAuthenticatesAsService() throws Exception {
        MockHttpServletRequest request = request(KEY);
        MockHttpServletResponse response = new MockHttpServletResponse();
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, response, chain);

        assertThat(response.getStatus()).isEqualTo(200);
        assertThat(chain.getRequest()).isNotNull();
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        assertThat(authentication).isNotNull();
        assertThat(authentication.getName()).isEqualTo("dsh-service");
        assertThat(authentication.getAuthorities())
            .anyMatch(authority -> "ROLE_SERVICE".equals(authority.getAuthority()));
    }

    @Test
    void mismatchedKeyLeavesRequestUnauthenticated() throws Exception {
        MockHttpServletRequest request = request("wrong-key");
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, new MockHttpServletResponse(), chain);

        assertThat(chain.getRequest()).isNotNull();
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    }

    @Test
    void requestWithoutHeaderPassesThroughUnauthenticated() throws Exception {
        MockHttpServletRequest request = request(null);
        MockFilterChain chain = new MockFilterChain();

        filter.doFilter(request, new MockHttpServletResponse(), chain);

        assertThat(chain.getRequest()).isNotNull();
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    }

    @Test
    void blankConfiguredKeyNeverAuthenticates() throws IOException, jakarta.servlet.ServletException {
        ServiceKeyAuthFilter unconfigured =
            new ServiceKeyAuthFilter(new DshWebConsoleProperties("http://console:8080", " "));
        MockHttpServletRequest request = request(KEY);
        MockFilterChain chain = new MockFilterChain();

        unconfigured.doFilter(request, new MockHttpServletResponse(), chain);

        assertThat(chain.getRequest()).isNotNull();
        assertThat(SecurityContextHolder.getContext().getAuthentication()).isNull();
    }
}
