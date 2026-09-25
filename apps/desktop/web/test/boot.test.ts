import { describe, expect, it } from 'vitest';

// no window here: an import that reached for one would throw before a single assertion ran
describe('importing the app', () => {
  it('builds nothing until initApp', async () => {
    const { app, deps } = await import('../src/boot.js');
    expect(() => app.store).toThrow('initApp() before use');
    expect(() => app.bridge).toThrow('initApp() before use');
    expect(() => app.api()).toThrow('initApp() before use');
    expect(() => app.manager()).toThrow('initApp() before use');
    expect(() => app.browser()).toThrow('initApp() before use');
    expect(() => app.repoWatch()).toThrow('initApp() before use');
    expect(() => deps()).toThrow('initApp() before use');
  });

  it('builds nothing on the phone until initPhone', async () => {
    const { phone } = await import('../src/mobile/boot.js');
    expect(() => phone.store).toThrow('initPhone() before use');
    expect(() => phone.api()).toThrow('initPhone() before use');
    expect(() => phone.onTermEvent(() => {})).toThrow('initPhone() before use');
  });
});
