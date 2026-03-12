export type InterviewQa = { q: string; a: string };

export type InterviewNextQuestion = {
  done: boolean;
  question: string;
  why: string;
};

export type InterviewBatchQuestions = {
  questions: string[];
  why: string;
};

function extractJsonObject(text: string): string | null {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return null;
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last < 0 || last <= first) {
    return null;
  }
  return raw.slice(first, last + 1);
}

function normalizeRawQuestionText(text: string): string {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return "";
  }
  // Avoid accidental huge payloads in the UI.
  const limit = 5000;
  if (raw.length > limit) {
    return `${raw.slice(0, limit)}\n…（已截断）`;
  }
  return raw;
}

function extractQuestionsFromPlainText(text: string): string[] {
  const raw = normalizeRawQuestionText(text);
  if (!raw) {
    return [];
  }

  const lines = raw
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const out: string[] = [];
  for (const line of lines) {
    const n = line.match(/^\d+[\.\)]\s*(.+)$/);
    if (n && n[1]) {
      out.push(n[1].trim());
      continue;
    }
    const b = line.match(/^[-*]\s+(.+)$/);
    if (b && b[1]) {
      out.push(b[1].trim());
      continue;
    }
  }

  if (out.length > 0) {
    const qLike = out.filter((q) => /[?？]\s*$/.test(q));
    return qLike.length > 0 ? qLike : out;
  }

  // As a last resort, treat the whole output as a single "question" blob.
  const firstQuestion = raw
    .split(/[\r\n]+/g)
    .map((l) => l.trim())
    .find((l) => /[?？]\s*$/.test(l));
  return [firstQuestion ?? raw];
}

export function parseInterviewNextQuestion(
  text: string
): { ok: true; value: InterviewNextQuestion } | { ok: false; error: string } {
  const jsonText = extractJsonObject(text);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as Partial<InterviewNextQuestion>;
      if (typeof parsed.done !== "boolean") {
        return { ok: false, error: "JSON 缺少 done:boolean" };
      }
      const questionRaw = typeof parsed.question === "string" ? parsed.question : "";
      const question = parsed.done ? "" : (extractQuestionsFromPlainText(questionRaw)[0] ?? questionRaw);
      const why = typeof parsed.why === "string" ? parsed.why : "";
      if (!parsed.done && question.trim().length === 0) {
        return { ok: false, error: "JSON 缺少 question:string" };
      }
      return { ok: true, value: { done: parsed.done, question, why } };
    } catch (err) {
      // Fall back to plain text.
    }
  }

  const questions = extractQuestionsFromPlainText(text);
  const rawQuestion = questions[0] ?? "";
  if (!rawQuestion) {
    return { ok: false, error: "输出为空" };
  }
  return {
    ok: true,
    value: {
      done: false,
      question: rawQuestion,
      why: "（提示：模型没有按 JSON 输出，已直接使用原始问题文本。）"
    }
  };
}

export function parseInterviewBatchQuestions(
  text: string
): { ok: true; value: InterviewBatchQuestions } | { ok: false; error: string } {
  const jsonText = extractJsonObject(text);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as Partial<InterviewBatchQuestions>;
      const why = typeof parsed.why === "string" ? parsed.why : "";
      const raw = Array.isArray(parsed.questions) ? parsed.questions : null;
      if (raw) {
        const questions = raw.filter((q): q is string => typeof q === "string").map((q) => q.trim()).filter(Boolean);
        if (questions.length > 0) {
          return { ok: true, value: { questions, why } };
        }
      }
    } catch {
      // Fall through.
    }
  }

  const questions = extractQuestionsFromPlainText(text);
  if (questions.length === 0) {
    return { ok: false, error: "输出为空" };
  }
  return {
    ok: true,
    value: {
      questions,
      why: "（提示：模型没有按 JSON 输出，已从文本中提取问题列表。）"
    }
  };
}

export function formatInterviewTranscript(seed: string, qa: InterviewQa[]): string {
  const lines: string[] = [];
  lines.push(`产品想法：${seed.trim() || "（未填写）"}`);
  lines.push("");
  lines.push("访谈记录：");
  if (qa.length === 0) {
    lines.push("（暂无）");
    return lines.join("\n");
  }
  for (let i = 0; i < qa.length; i += 1) {
    const item = qa[i]!;
    lines.push(`Q${i + 1}. ${item.q}`.trimEnd());
    lines.push(`A${i + 1}. ${item.a}`.trimEnd());
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
