/** Progressive enhancement: nothing is hidden while waiting for JavaScript or an observer. */
export function initLandingMotion() {
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (motion.matches || !('IntersectionObserver' in window)) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.intersectionRatio < 0.2) continue;
      observer.unobserve(entry.target);
      // Never fade a control someone is already using with the keyboard.
      if (!entry.target.matches(':focus-within')) entry.target.classList.add('lp-enter');
    }
  }, { threshold: 0.2, rootMargin: '0px 0px -24px 0px' });

  document.querySelectorAll('[data-motion="reveal"]').forEach((element) => {
    if (element.getBoundingClientRect().top > window.innerHeight) observer.observe(element);
  });

  const stop = () => {
    observer.disconnect();
    document.querySelectorAll('.lp-enter').forEach((element) => { element.classList.remove('lp-enter'); });
  };
  const onPreferenceChange = () => {
    if (motion.matches) stop();
  };
  motion.addEventListener('change', onPreferenceChange);
  // Includes focus that arrives during a delayed entrance, not just before it.
  const onFocus = (event: FocusEvent) => {
    if (!(event.target instanceof Element)) return;
    event.target.closest('[data-motion="hero"]')?.setAttribute('data-motion-done', '');
    event.target.closest('.lp-enter')?.classList.remove('lp-enter');
  };
  document.addEventListener('focusin', onFocus);
  window.addEventListener('pagehide', () => {
    stop();
    motion.removeEventListener('change', onPreferenceChange);
    document.removeEventListener('focusin', onFocus);
  }, { once: true });
}
