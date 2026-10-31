# steve-sketch (Python)

CPython binding of the STEVE sketch solver core (FreeCAD planegcs behind the Solver JSON
contract of docs/MODELING.md section 2). Same C++ core and flags as the WebAssembly build.

```python
import json, steve_sketch
result = json.loads(steve_sketch.solve(json.dumps(sketch)))
session = steve_sketch.Session(json.dumps(sketch))
frame = json.loads(session.drag("l1.end", 10.0, 5.0))
```

Build and licensing: see solver/README.md in the STEVE repository.
