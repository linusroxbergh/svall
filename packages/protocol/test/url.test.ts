import { describe, expect, it } from 'vitest';
import { toUrl } from '../src/index.js';

describe('toUrl', () => {
  it('keeps a loadable scheme, adds https to a host, and searches anything else', () => {
    expect(toUrl('https://a.test/x?y=1')).toBe('https://a.test/x?y=1');
    expect(toUrl('  example.com ')).toBe('https://example.com');
    expect(toUrl('localhost:5173/app')).toBe('http://localhost:5173/app');
    expect(toUrl('example.com:8080')).toBe('https://example.com:8080');
    expect(toUrl('mailto:me@example.com')).toBe('mailto:me@example.com');
    expect(toUrl('https://a.test/a b')).toBe('https://a.test/a b');
    expect(toUrl('data:text/html,<p>hi there</p>')).toBe('data:text/html,<p>hi there</p>');
    expect(toUrl('what is a webview')).toBe('https://www.google.com/search?q=what%20is%20a%20webview');
    expect(toUrl('python: list comprehension')).toBe('https://www.google.com/search?q=python%3A%20list%20comprehension');
    // a colon inside a phrase is not a scheme, and a scheme the view cannot show is not a url
    expect(toUrl('error:cannot find module')).toBe('https://www.google.com/search?q=error%3Acannot%20find%20module');
    expect(toUrl('x-apple.systempreferences:com.apple.preference.security')).toBe('https://www.google.com/search?q=x-apple.systempreferences%3Acom.apple.preference.security');
    expect(toUrl('')).toBe('');
  });

  it('gives a loopback host http, and any other IP address https', () => {
    expect(toUrl('127.0.0.1:5173')).toBe('http://127.0.0.1:5173');
    expect(toUrl('127.0.0.1:8080/api')).toBe('http://127.0.0.1:8080/api');
    expect(toUrl('0.0.0.0:3000')).toBe('http://0.0.0.0:3000');
    expect(toUrl('[::1]:3000')).toBe('http://[::1]:3000');
    expect(toUrl('app.localhost:3000')).toBe('http://app.localhost:3000');
    expect(toUrl('10.0.0.1:3000')).toBe('https://10.0.0.1:3000');
    expect(toUrl('[2001:db8::1]:8443/x')).toBe('https://[2001:db8::1]:8443/x');
  });
});
