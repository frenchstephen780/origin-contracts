// Conservative append-only check, recursively including struct members,
// mapping values and array elements. Compiler-generated type ids may change.
// ERC-7201 namespace declarations also require source review; solc's ordinary
// storageLayout does not enumerate assembly-addressed namespace slots.
function shape(layout, typeId, seen = new Set()) {
  const type = layout.types[typeId];
  if (!type) throw Error(`Missing storage type: ${typeId}`);
  if (seen.has(typeId)) return {recursive: type.label};
  const next = new Set([...seen, typeId]);
  const result = {encoding: type.encoding, label: type.label, bytes: type.numberOfBytes};
  for (const key of ['base', 'key', 'value']) if (type[key]) result[key] = shape(layout, type[key], next);
  if (type.members) result.members = type.members.map(m => ({label: m.label, slot: m.slot, offset: m.offset, type: shape(layout, m.type, next)}));
  return result;
}

export function assertCompatibleStorage(previous, next) {
  if (!previous?.storage || !next?.storage || next.storage.length < previous.storage.length) throw Error('Missing or shortened storage layout');
  for (let i = 0; i < previous.storage.length; ++i) {
    const a = previous.storage[i], b = next.storage[i];
    if (a.label !== b.label || a.slot !== b.slot || a.offset !== b.offset ||
        JSON.stringify(shape(previous, a.type)) !== JSON.stringify(shape(next, b.type))) {
      throw Error(`Incompatible storage at ${a.label} (index ${i})`);
    }
  }
  return true;
}

export function assertArtifactRuntime(artifact, code) {
  if (!artifact.immutableReferences || !artifact.deployedBytecode) throw Error('Recompile/snapshot artifact with immutableReferences');
  const expected = Buffer.from(artifact.deployedBytecode.slice(2), 'hex');
  const actual = Buffer.from(code.slice(2), 'hex');
  if (!actual.length || expected.length !== actual.length) throw Error('Implementation bytecode does not match artifact');
  for (const references of Object.values(artifact.immutableReferences)) for (const {start, length} of references) {
    expected.fill(0, start, start + length); actual.fill(0, start, start + length);
  }
  if (!expected.equals(actual)) throw Error('Implementation bytecode does not match artifact');
}
