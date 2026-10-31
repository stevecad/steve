# Viewport assets — sources and licenses

All files here are CC0 1.0 (public domain dedication). Fetched and processed by `scripts/materials/assets.py`
(`uv run --with pillow --with numpy python scripts/materials/assets.py`).

| File | Source | Author | License | Processing |
|---|---|---|---|---|
| `studio.hdr` | [Poly Haven — Studio Small 08](https://polyhaven.com/a/studio_small_08), 1k HDR | Sergej Majboroda | CC0 1.0 | none (1024×512 Radiance RGBE, equirectangular, Y-up) |
| `brushed_normal.jpg`, `brushed_roughness.jpg` | [ambientCG — Metal 009](https://ambientcg.com/view?id=Metal009), 1K-JPG | ambientCG (Lennart Demes) | CC0 1.0 | NormalGL / Roughness, resized to 512×512 |
| `grain_normal.jpg`, `grain_roughness.jpg` | [ambientCG — Metal 045 B](https://ambientcg.com/view?id=Metal045B), 1K-JPG | ambientCG (Lennart Demes) | CC0 1.0 | NormalGL / Roughness, resized to 512×512 |
| `wood_normal.jpg`, `wood_roughness.jpg`, `wood_color.jpg` | [ambientCG — Wood 049](https://ambientcg.com/view?id=Wood049), 1K-JPG | ambientCG (Lennart Demes) | CC0 1.0 | NormalGL / Roughness resized to 512×512; `wood_color.jpg` is the color map's luminance, scaled so its mean is 0.5 (a detail map multiplied with each species' base color × 2) |

Textures are seamless tiles; brushed lines and wood grain run along the image's horizontal (U) axis. Normal maps
use the OpenGL convention (+Y up), which three.js expects.
