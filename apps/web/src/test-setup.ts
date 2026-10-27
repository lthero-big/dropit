// happy-dom rejects Animation.finished when an animation is cancelled, and
// motion cancels in-flight WAAPI animations when a card unmounts during test
// cleanup. Browsers report that rejection to the caller, which motion handles;
// in happy-dom it surfaces as an unhandled rejection, so mark it handled here.
const animate = HTMLElement.prototype.animate
HTMLElement.prototype.animate = function patchedAnimate(this: HTMLElement, ...args: Parameters<typeof animate>) {
  const animation = animate.apply(this, args)
  animation.finished?.catch(() => undefined)
  return animation
}
