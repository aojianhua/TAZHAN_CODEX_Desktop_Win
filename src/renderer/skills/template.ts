type Answers = Record<string, unknown>;

function toDisplayText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function asBulletList(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) {
    return "";
  }
  return lines
    .map((l) => {
      if (/^[-*]\s+/.test(l)) {
        return l;
      }
      return `- ${l}`;
    })
    .join("\n");
}

function applyFilter(value: string, filter: string | null): string {
  if (!filter) {
    return value;
  }
  if (filter === "bullets") {
    return asBulletList(value);
  }
  return value;
}

export function renderSkillTemplate(template: string, answers: Answers): string {
  const fallback = "（未填写）";
  return template.replace(/{{\s*([a-zA-Z0-9_-]+)(?:\s*\|\s*([a-zA-Z0-9_-]+))?\s*}}/g, (_m, rawKey, rawFilter) => {
    const key = String(rawKey);
    const filter = rawFilter ? String(rawFilter) : null;
    const raw = toDisplayText(answers[key]);
    const value = applyFilter(raw, filter).trimEnd();
    if (!value.trim()) {
      return fallback;
    }
    return value;
  });
}
