# 3D orb prototype

A Three.js fren, built to answer one question: does real geometry buy anything
the painted SVG can't fake?

Run it:

```sh
node dev/serve.js          # then open http://localhost:8777/orb3d/index.html
```

Move the pointer to make it turn; click to poke it.

## What is genuinely different

| | SVG (shipped) | Three.js (this) |
|---|---|---|
| Specular | Painted on, stays put when the body leans | Real — moves as the orb turns |
| Face | Drawn on top of the sphere | An **emissive map**: light coming out of the material |
| Turning | `skewX`, which shears the whole picture | Real rotation; the face foreshortens around the curve |
| Deformation | Affine scale — a stretched sticker | Per-vertex displacement; the surface bulges |
| Shadow | A blurred ellipse | Cast from the geometry by the key light |
| Cost | ~630 lines, zero dependencies, loop halts at rest | three.js (~600KB), continuous GPU in an always-on window |

## What carried over unchanged

`face-texture.js` draws the face with the **same** construction as the SVG
renderer — plain circle eyes, and one mouth path filled AND stroked with round
caps and joins. The proportions are the same constants. That is the useful
finding: the character lives in the parameter space, not in the renderer, so
swapping renderers is a port of ~150 lines of drawing code, not a rewrite.
