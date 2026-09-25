import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no layout, so nothing a ResizeObserver watches ever changes size
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

// jsdom implements no visual viewport, and an undeclared global throws before `?.` can guard it
if (!('visualViewport' in globalThis)) Object.defineProperty(globalThis, 'visualViewport', { value: null, writable: true, configurable: true });

// jsdom lays nothing out, so it has nothing to scroll to, and a CodeMirror view measures a range of text as nothing
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Range.prototype.getClientRects ??= function getClientRects() { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect ??= function getBoundingClientRect() { return new DOMRect(); };

afterEach(cleanup);
