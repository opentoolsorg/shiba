import { createViewport, css, definePrimitive, live } from "@ui-sdk/core";
import { usePart, type PartProps } from "@ui-sdk/react/primitive";

export const computerCanvas = definePrimitive({
  name: "computer-canvas",
  state: () => ({ viewport: { x: 0, y: 0, zoom: 1 } }),
  live: ["viewport"],
  api: (context) => ({
    viewport: createViewport(context, {
      key: "viewport",
      surface: () => context.element("root"),
    }),
  }),
  slots: (slot) => ({
    root: slot({
      attrs: () => ({
        tabindex: "0",
        style: css({ position: "relative", overflow: "clip", "touch-action": "none" }),
      }),
      on: {
        pointerdown: (event, { el, api }) => {
          if (event.target === el) api.viewport.pointerdown(event);
        },
        keydown: (event, { el, api }) => {
          if (event.target === el) api.viewport.keydown(event);
        },
      },
    }),
    world: slot({
      attrs: () => ({ style: css({ position: "absolute", left: "0", top: "0", width: "100%" }) }),
      live: live((state, { api }) => ({ style: api.viewport.style(state) })),
    }),
  }),
});

export function CanvasWorld(props: PartProps<"div">) {
  return usePart(computerCanvas, "world", {}, props, "div");
}
