/**
 * Tests for the SECURITY-sensitive `trust proxy` configuration.
 *
 * The command-backend runs behind nginx (which sets X-Forwarded-For). Without
 * `app.set('trust proxy', …)`, express-rate-limit throws
 * ERR_ERL_UNEXPECTED_X_FORWARDED_FOR (444 occurrences observed in prod) and keys
 * every request off the proxy IP. These tests pin the config-driven behavior:
 *   - default is 'loopback' (safe for prod's single loopback nginx),
 *   - integer hop-counts and 'false' parse correctly,
 *   - it NEVER defaults to `true` (forging X-Forwarded-For must not bypass limits),
 *   - and the parsed value actually drives Express's trust-proxy resolver.
 */
import express from 'express';
import { parseTrustProxy } from '../config/environment';

describe('parseTrustProxy', () => {
  it("defaults to 'loopback' when unset or empty (safe for single loopback nginx)", () => {
    expect(parseTrustProxy(undefined)).toBe('loopback');
    expect(parseTrustProxy('')).toBe('loopback');
    expect(parseTrustProxy('   ')).toBe('loopback');
  });

  it('parses an integer hop-count to a number', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('3')).toBe(3);
  });

  it("parses 'false' (any case) to boolean false", () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('FALSE')).toBe(false);
  });

  it('passes named subnets through as-is', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('uniquelocal')).toBe('uniquelocal');
  });

  it('NEVER returns true by default (forge-XFF guard)', () => {
    expect(parseTrustProxy(undefined)).not.toBe(true);
    expect(parseTrustProxy('')).not.toBe(true);
  });
});

describe('config.trustProxy (env-driven)', () => {
  const ORIG = process.env.TRUST_PROXY;

  afterEach(() => {
    if (ORIG === undefined) {
      delete process.env.TRUST_PROXY;
    } else {
      process.env.TRUST_PROXY = ORIG;
    }
    jest.resetModules();
  });

  type TrustProxyConfig = { trustProxy: boolean | number | string };
  function loadConfig(): TrustProxyConfig {
    // jest.isolateModules runs its callback synchronously, so `cfg` is always
    // reassigned before we return; the initializer just satisfies the type.
    let cfg: TrustProxyConfig = { trustProxy: 'unset-sentinel' };
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      cfg = require('../config/environment').default as TrustProxyConfig;
    });
    return cfg;
  }

  it("is 'loopback' when TRUST_PROXY is unset", () => {
    delete process.env.TRUST_PROXY;
    expect(loadConfig().trustProxy).toBe('loopback');
  });

  it('is the integer hop-count when TRUST_PROXY=3', () => {
    process.env.TRUST_PROXY = '3';
    expect(loadConfig().trustProxy).toBe(3);
  });

  it('is false when TRUST_PROXY=false', () => {
    process.env.TRUST_PROXY = 'false';
    expect(loadConfig().trustProxy).toBe(false);
  });
});

describe('Express honors the config trust-proxy value', () => {
  it("with 'loopback' trusts 127.0.0.1 but not a public IP", () => {
    const app = express();
    app.set('trust proxy', parseTrustProxy(undefined)); // -> 'loopback'
    expect(app.get('trust proxy')).toBe('loopback');

    // Express compiles the setting into a resolver fn at 'trust proxy fn'.
    const trustFn = app.get('trust proxy fn') as (addr: string, i: number) => boolean;
    expect(trustFn('127.0.0.1', 0)).toBe(true); // loopback is trusted
    expect(trustFn('8.8.8.8', 0)).toBe(false); // an arbitrary public IP is NOT
  });

  it('with an integer hop-count trusts exactly that many hops', () => {
    const app = express();
    app.set('trust proxy', parseTrustProxy('1')); // -> 1
    expect(app.get('trust proxy')).toBe(1);

    const trustFn = app.get('trust proxy fn') as (addr: string, i: number) => boolean;
    expect(trustFn('1.2.3.4', 0)).toBe(true); // first hop (the immediate proxy)
    expect(trustFn('5.6.7.8', 1)).toBe(false); // beyond the trusted hop count
  });
});
