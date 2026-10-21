export function stripKeys(node, keys) {
  const drop = keys instanceof Set ? keys : new Set(keys);

  function walk(value) {
    if (Array.isArray(value)) {
      return value.map(walk);
    }

    if (value && typeof value === "object") {
      const result = {};
      for (const [key, child] of Object.entries(value)) {
        if (drop.has(key)) continue;
        result[key] = walk(child);
      }
      return result;
    }

    return value;
  }

  return walk(node);
}

export const keyOrderSerializer = {
  test(val) {
    return (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      Object.getPrototypeOf(val) === Object.prototype
    );
  },
  serialize(val, config, indentation, depth, refs, printer) {
    const entries = Object.entries(val);
    if (entries.length === 0) return "{}";
    const childIndent = indentation + config.indent;
    const parts = entries.map(
      ([k, v]) =>
        `${childIndent}${JSON.stringify(k)}: ${printer(v, config, childIndent, depth + 1, refs)}`,
    );
    return `{\n${parts.join(",\n")},\n${indentation}}`;
  },
};
