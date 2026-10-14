import { describe, expect, it } from 'vitest'
import { DEFAULT_SSO_SCOPES, resolveSsoSettings } from '../src/index.ts'

describe('resolveSsoSettings', () => {
  it('缺省 provider=supabase,issuer/jwksUrl 按 Supabase 约定推导,scopes 缺省 openid profile', () => {
    expect(resolveSsoSettings({ supabaseUrl: 'https://example.supabase.co' })).toEqual({
      provider: 'supabase',
      supabaseUrl: 'https://example.supabase.co',
      issuer: 'https://example.supabase.co/auth/v1',
      jwksUrl: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
      clientId: '',
      scopes: 'openid profile',
    })
  })

  it('全空输入是未配置合法初态(员工端首启引导依赖),不抛错', () => {
    expect(resolveSsoSettings({})).toEqual({
      provider: 'supabase',
      supabaseUrl: '',
      issuer: '',
      jwksUrl: '',
      clientId: '',
      scopes: DEFAULT_SSO_SCOPES,
    })
  })

  it('显式 issuer/jwksUrl 覆盖推导,末尾斜杠被修剪', () => {
    expect(resolveSsoSettings({
      supabaseUrl: 'https://example.supabase.co/',
      issuer: 'https://sso.corp.example.com/',
      jwksUrl: 'https://sso.corp.example.com/keys.json',
    })).toEqual({
      provider: 'supabase',
      supabaseUrl: 'https://example.supabase.co',
      issuer: 'https://sso.corp.example.com',
      jwksUrl: 'https://sso.corp.example.com/keys.json',
      clientId: '',
      scopes: 'openid profile',
    })
  })

  it('provider 非法值直接抛错(fails loud)', () => {
    expect(() => resolveSsoSettings({ provider: 'keycloak', issuer: 'https://kc.example.com' }))
      .toThrow('provider must be one of supabase | casdoor | customer-oidc, got "keycloak"')
  })

  it('非 supabase provider 缺 issuer 抛错,显式给出后按 OIDC 发现推导 jwksUrl', () => {
    expect(() => resolveSsoSettings({ provider: 'casdoor' })).toThrow(
      'provider "casdoor" requires an explicit issuer (no derivation outside supabase)',
    )
    expect(resolveSsoSettings({ provider: 'casdoor', issuer: 'https://door.example.com' })).toEqual({
      provider: 'casdoor',
      supabaseUrl: '',
      issuer: 'https://door.example.com',
      jwksUrl: 'https://door.example.com/.well-known/jwks.json',
      clientId: '',
      scopes: 'openid profile',
    })
  })

  it('所有非空 URL 必须 http(s),clientId/scopes 原样透传', () => {
    expect(() => resolveSsoSettings({ supabaseUrl: 'ftp://example.supabase.co' }))
      .toThrow('supabaseUrl must be an http(s) URL')
    expect(() => resolveSsoSettings({ issuer: 'not-a-url' }))
      .toThrow('issuer must be an http(s) URL')
    expect(() => resolveSsoSettings({ provider: 'casdoor', issuer: 'https://door.example.com', jwksUrl: 'gopher://x' }))
      .toThrow('jwksUrl must be an http(s) URL')
    const resolved = resolveSsoSettings({
      provider: 'customer-oidc',
      issuer: 'https://idp.example.com',
      clientId: 'dsh-rp',
      scopes: 'openid profile email',
    })
    expect(resolved.clientId).toBe('dsh-rp')
    expect(resolved.scopes).toBe('openid profile email')
  })
})
