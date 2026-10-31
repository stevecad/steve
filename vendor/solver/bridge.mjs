// SteveLocal transport adapter. The solver module itself is upstream, unmodified.
import createSolver from './steve-sketch.mjs';
import readline from 'node:readline';
const m = await createSolver();
for await (const line of readline.createInterface({input: process.stdin})) {
  const pointers = [];
  try {
    const {sketch, options} = JSON.parse(line);
    for (const text of [sketch, options || '{}']) {
      const length = m.lengthBytesUTF8(text) + 1;
      const pointer = m._malloc(length);
      if (!pointer) throw Error('Solver out of memory');
      m.stringToUTF8(text, pointer, length);
      pointers.push(pointer);
    }
    const answer = m._steve_solve(...pointers);
    if (!answer) throw Error(m.UTF8ToString(m._steve_last_error()));
    process.stdout.write(JSON.stringify({result: m.UTF8ToString(answer)}) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({error: String(error.message)}) + '\n');
  } finally {
    pointers.forEach(p => m._free(p));
  }
}
