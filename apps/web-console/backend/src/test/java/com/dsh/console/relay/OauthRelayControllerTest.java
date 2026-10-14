package com.dsh.console.relay;

import com.dsh.console.common.ApiResponse;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.Optional;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

/**
 * OauthRelayController 行为测试:register 校验 state/returnOrigin(必填、长度、
 * http/https scheme)后才落库;callback 缺参拒绝、会话不存在拒绝且不产生
 * 转交地址、成功时 302 转交回员工端回调端点(code/state 原样透传)。
 */
class OauthRelayControllerTest {

    private static final String STATE = "st-123";
    private static final String RETURN_ORIGIN = "https://e123.tunnel.example.com";

    private OauthRelayJdbcRepository repository;
    private OauthRelayController controller;

    @BeforeEach
    void setUp() {
        repository = Mockito.mock(OauthRelayJdbcRepository.class);
        controller = new OauthRelayController(repository);
    }

    @Test
    void registerPersistsStateAndOrigin() {
        ApiResponse<Void> response = controller.register(
            new OauthRelayController.RelayRegisterRequest(STATE, RETURN_ORIGIN));

        assertThat(response.success()).isTrue();
        verify(repository).register(STATE, RETURN_ORIGIN);
    }

    @Test
    void registerRejectsMissingFields() {
        assertThatThrownBy(() -> controller.register(
            new OauthRelayController.RelayRegisterRequest(null, RETURN_ORIGIN)))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("state 缺失或格式无效");
        assertThatThrownBy(() -> controller.register(
            new OauthRelayController.RelayRegisterRequest(STATE, " ")))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("returnOrigin 缺失或格式无效");
        verify(repository, never()).register(anyString(), anyString());
    }

    @Test
    void registerRejectsNonHttpSchemes() {
        assertThatThrownBy(() -> controller.register(
            new OauthRelayController.RelayRegisterRequest(STATE, "javascript:alert(1)")))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("仅支持 http/https 地址");
        verify(repository, never()).register(anyString(), anyString());
    }

    @Test
    void registerRejectsOversizedFields() {
        String oversized = "x".repeat(256);
        assertThatThrownBy(() -> controller.register(
            new OauthRelayController.RelayRegisterRequest(oversized, RETURN_ORIGIN)))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("超过长度上限");
        verify(repository, never()).register(anyString(), anyString());
    }

    @Test
    void callbackRejectsMissingParams() {
        assertThatThrownBy(() -> controller.callback(" ", STATE))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("code 缺失或格式无效");
        assertThatThrownBy(() -> controller.callback("auth-code", ""))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("state 缺失或格式无效");
    }

    @Test
    void callbackRejectsUnknownOrExpiredSession() {
        when(repository.take(STATE)).thenReturn(Optional.empty());

        assertThatThrownBy(() -> controller.callback("auth-code", STATE))
            .isInstanceOf(IllegalArgumentException.class)
            .hasMessageContaining("relay 会话不存在或已过期");
    }

    @Test
    void callbackRedirectsBackToDshCallbackEndpoint() {
        when(repository.take(STATE)).thenReturn(Optional.of(RETURN_ORIGIN));

        ResponseEntity<Void> response = controller.callback("auth-code", STATE);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.FOUND);
        String location = response.getHeaders().getLocation().toString();
        assertThat(location).startsWith(RETURN_ORIGIN + OauthRelayController.DSH_CALLBACK_PATH);
        assertThat(location).contains("code=auth-code");
        assertThat(location).contains("state=" + STATE);
    }

    @Test
    void callbackEncodesQueryParamsInLocation() {
        when(repository.take("st-1")).thenReturn(Optional.of("http://192.168.1.5:3081"));

        ResponseEntity<Void> response = controller.callback("code with spaces&+", "st-1");

        String location = response.getHeaders().getLocation().toString();
        assertThat(location).startsWith("http://192.168.1.5:3081" + OauthRelayController.DSH_CALLBACK_PATH);
        // query 参数被 URI 编码,原样字节不出现在 Location 里
        assertThat(location).doesNotContain(" ");
        assertThat(location).contains("code%20with%20spaces");
    }
}
