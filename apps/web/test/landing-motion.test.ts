import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initLandingMotion } from '../src/lib/landing-motion.ts';

test('landing motion skips visible content and respects focus and reduced motion', () => {
  const previous = ['window', 'document', 'Element', 'IntersectionObserver'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(globalThis, name),
  ] as const);
  const makeElement = (top: number, focused = false) => {
    const classes = new Set<string>();
    return {
      classes,
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
      getBoundingClientRect: () => ({ top }),
      matches: (selector: string) => selector === ':focus-within' && focused,
      closest: () => null as MockElement | null,
    };
  };
  type MockElement = ReturnType<typeof makeElement>;

  const visible = makeElement(120);
  const reveal = makeElement(900);
  const focusedReveal = makeElement(900, true);
  let callback: (entries: Array<{ target: MockElement; isIntersecting: boolean; intersectionRatio: number }>) => void = () => {};
  let observed = 0;
  let unobserved = 0;
  let disconnected = 0;
  let preferenceChange = () => {};
  const removedMediaListeners: string[] = [];
  const removedDocumentListeners: string[] = [];
  const selectors: string[] = [];
  let pagehideRegistered = false;
  const preference = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => { preferenceChange = listener; },
    removeEventListener: (type: string) => { removedMediaListeners.push(type); },
  };
  const windowMock: Record<string, unknown> = {
    innerHeight: 800,
    matchMedia: () => preference,
    addEventListener: (type: string, listener: () => void) => { if (type === 'pagehide') { pagehide = listener; pagehideRegistered = true; } },
    removeEventListener: () => {},
  };
  let focusIn = (_event: { target: unknown }) => {};
  let pagehide = () => {};
  const documentMock = {
    querySelectorAll: (selector: string) => {
      selectors.push(selector);
      return selector === '[data-motion="reveal"]' ? [visible, reveal, focusedReveal] : [];
    },
    addEventListener: (_: string, listener: typeof focusIn) => { focusIn = listener; },
    removeEventListener: (type: string) => { removedDocumentListeners.push(type); },
  };

  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: windowMock });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: documentMock });

    initLandingMotion();
    assert.equal(observed, 0, 'without IntersectionObserver, reveals stay visible');

    const Observer = class {
      constructor(listener: typeof callback) { callback = listener; }
      observe() { observed++; }
      unobserve() { unobserved++; }
      disconnect() { disconnected++; }
    };
    windowMock.IntersectionObserver = Observer;
    Object.defineProperty(globalThis, 'IntersectionObserver', { configurable: true, value: Observer });
    initLandingMotion();
    assert.deepEqual(selectors, ['[data-motion="reveal"]']);
    assert.equal(observed, 2, 'only below-the-fold content is observed');

    callback([{ target: focusedReveal, isIntersecting: true, intersectionRatio: 0.3 }]);
    assert.equal(focusedReveal.classes.size, 0, 'focused content is not animated');
    callback([{ target: reveal, isIntersecting: true, intersectionRatio: 0.1 }]);
    assert.equal(reveal.classes.size, 0, 'threshold prevents early reveal');
    callback([{ target: reveal, isIntersecting: true, intersectionRatio: 0.3 }]);
    assert.ok(reveal.classes.has('lp-enter'));
    assert.equal(unobserved, 2, 'reveals are observed only once');

    class FocusTarget {
      closest(selector: string) {
        if (selector === '.lp-enter') return reveal;
        return null;
      }
    }
    Object.defineProperty(globalThis, 'Element', { configurable: true, value: FocusTarget });
    focusIn({ target: new FocusTarget() });
    assert.equal(reveal.classes.size, 0, 'keyboard focus cancels an active entrance');

    preference.matches = true;
    preferenceChange();
    assert.equal(disconnected, 1);
    assert.equal(reveal.classes.size, 0, 'reduced-motion change clears active classes');
    initLandingMotion();
    assert.equal(observed, 2, 'reduced motion bypasses initialization');

    assert.ok(pagehideRegistered, 'pagehide cleanup handler is installed');
    pagehide();
    assert.equal(disconnected, 2, 'pagehide disconnects the observer');
    assert.ok(removedMediaListeners.includes('change'));
    assert.ok(removedDocumentListeners.includes('focusin'));
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
