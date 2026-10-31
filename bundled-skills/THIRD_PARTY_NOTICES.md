# Third-party notices for STEVE's built-in skills

The skills `dfm-sheet-metal`, `dfm-cnc`, `dfm-injection-molding`, `dfam-3d-printing` and `sendcutsend-preflight` are adapted from
the `dfm`, `dfam-check` and `sendcutsend` skills of https://github.com/earthtojake/text-to-cad, rewritten for STEVE's tools.
The generic process limits in app/manufacturing_checks.py come from the same skills' references.

```
MIT License

Copyright (c) 2026 Thompson Labs LLC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## electronics (and electronics-* stage skills)

The skills `electronics`, `electronics-requirements`, `electronics-architecture`, `electronics-parts`,
`electronics-schematic`, `electronics-layout`, `electronics-routing`, `electronics-checks` and
`electronics-fabrication` are adapted from https://github.com/tscircuit/skill, rewritten for STEVE's tools.
tscircuit was created by Seve Ibarluzea and contributors.

```
MIT License

Copyright (c) 2026 tscircuit

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Blender skill and local runtime provenance is recorded in `provenance.json`
and `vendor/blender/UPSTREAM.txt`. Blender itself is an optional external GPL-licensed
installation downloaded from blender.org; its upstream distribution retains its
license and notices. No Blender binary is bundled into the Steve executable.
