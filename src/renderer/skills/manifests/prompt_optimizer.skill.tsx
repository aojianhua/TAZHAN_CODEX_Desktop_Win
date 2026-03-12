import React, { useMemo, useState } from "react";

import type { SkillCustomManifestV1, SkillCustomRenderProps } from "../types";

type ExpertResult = {
  id: string;
  roleName: string;
  roleDescription: string;
  temperature: number;
  round: number;
  ok: boolean;
  text: string;
  error: string | null;
  systemPrompt: string;
  userPrompt: string;
};

type SendMode = "finalOnly" | "finalWithContext" | "full";
type RoleMode = "auto" | "manual";

type AssignedRole = {
  name: string;
  focus: string;
};

type PlannedExpert = {
  roleName: string;
  roleDescription: string;
  temperature: number;
  prompt: string;
};

type ManagerPlan = {
  thoughtProcess: string;
  experts: PlannedExpert[];
};

type ReviewResult = {
  satisfied: boolean;
  critique: string;
  nextRoundStrategy: string;
  refinedExperts: PlannedExpert[];
};

function defaultRolesText(): string {
  return [
    "资深软件工程师（实现与风险）",
    "产品经理（目标与边界）",
    "测试/QA（验收与回归）"
  ].join("\n");
}

function buildTranscript(turns: string[]): string {
  const cleaned = turns.map((t) => t.trim()).filter(Boolean);
  if (cleaned.length === 0) {
    return "";
  }
  if (cleaned.length === 1) {
    return cleaned[0]!;
  }
  return cleaned.map((t, idx) => `【第${idx + 1}条】\n${t}`).join("\n\n");
}

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

function clampInt(value: number, min: number, max: number): number {
  const v = Number.isFinite(value) ? Math.floor(value) : min;
  return Math.min(max, Math.max(min, v));
}

function parseAssignedRolesFromText(text: string): { ok: true; roles: AssignedRole[] } | { ok: false; error: string } {
  const jsonText = extractJsonObject(text);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as any;
      const raw = Array.isArray(parsed?.roles) ? parsed.roles : null;
      if (raw) {
        const roles: AssignedRole[] = [];
        for (const r of raw) {
          const name = typeof r?.name === "string" ? r.name.trim() : "";
          const focus = typeof r?.focus === "string" ? r.focus.trim() : "";
          if (!name) {
            continue;
          }
          roles.push({ name, focus });
        }
        if (roles.length > 0) {
          return { ok: true, roles };
        }
      }
    } catch {
      // Fall through to plain text.
    }
  }

  // Plain text fallback: only accept lines that look like role headers.
  // This avoids treating preambles ("下面给出 N=3...") as role names.
  const lines = String(text ?? "")
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean);

  const roles: AssignedRole[] = [];
  for (const line of lines) {
    const content = line.replace(/^[-*]\s+/, "").trim();
    if (!content) {
      continue;
    }

    const roleHeader = content.match(/^角色\s*\S*\s*[：:]\s*(.+)$/);
    if (roleHeader && roleHeader[1]) {
      roles.push({ name: roleHeader[1].trim(), focus: "" });
      continue;
    }

    const target = content.match(/^目标\s*[：:]\s*(.+)$/);
    if (target && target[1] && roles.length > 0) {
      const last = roles[roles.length - 1]!;
      if (!last.focus.trim()) {
        last.focus = target[1].trim();
      }
    }
  }

  if (roles.length === 0) {
    return { ok: false, error: "主持人分配角色失败：没有识别到角色行（请让主持人按 JSON 格式输出）" };
  }

  return { ok: true, roles };
}

function clampTemp(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 0.7;
  return Math.min(1.5, Math.max(0, n));
}

function parsePlannedExpertsFromText(text: string): { ok: true; value: ManagerPlan } | { ok: false; error: string } {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return { ok: false, error: "主持人编排失败：没有 JSON 输出" };
  }
  try {
    const parsed = JSON.parse(jsonText) as any;
    const thoughtProcess =
      typeof parsed?.thought_process === "string"
        ? parsed.thought_process
        : typeof parsed?.thoughtProcess === "string"
          ? parsed.thoughtProcess
          : "";
    const raw = Array.isArray(parsed?.experts) ? parsed.experts : null;
    if (!raw) {
      return { ok: false, error: "主持人编排失败：缺少 experts 数组" };
    }

    function toShortLines(value: unknown, limit: number): string[] {
      const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/g) : [];
      const items = raw
        .map((x) => (typeof x === "string" ? x : ""))
        .map((x) => x.trim())
        .filter(Boolean);
      return items.slice(0, Math.max(0, limit));
    }

    function buildPromptFallback(e: any): string {
      const responsibilities = toShortLines(e?.responsibilities, 8);
      const deliverables = toShortLines(e?.deliverables, 8);
      const handoffs = toShortLines(e?.handoffs, 6);

      const parts: string[] = [];
      if (responsibilities.length > 0) {
        parts.push("你需要重点覆盖：");
        for (const it of responsibilities) {
          parts.push(`- ${it}`);
        }
      }
      if (deliverables.length > 0) {
        parts.push("");
        parts.push("你需要产出：");
        for (const it of deliverables) {
          parts.push(`- ${it}`);
        }
      }
      if (handoffs.length > 0) {
        parts.push("");
        parts.push("协作/交接：");
        for (const it of handoffs) {
          parts.push(`- ${it}`);
        }
      }

      const body = parts.join("\n").trim();
      if (body) {
        return body;
      }
      // Last-resort: generic expert prompt.
      return "请从你的专家视角，提出可执行建议，并输出一份可直接发给 code agent 的最终提示词草案。";
    }

    const experts: PlannedExpert[] = [];
    for (const e of raw) {
      const roleName =
        typeof e?.roleName === "string"
          ? e.roleName.trim()
          : typeof e?.role === "string"
            ? e.role.trim()
            : typeof e?.name === "string"
              ? e.name.trim()
              : "";
      const roleDescription =
        typeof e?.roleDescription === "string"
          ? e.roleDescription.trim()
          : typeof e?.description === "string"
            ? e.description.trim()
            : typeof e?.specialty === "string"
              ? e.specialty.trim()
              : "";
      const promptRaw = typeof e?.prompt === "string" ? e.prompt.trim() : "";
      const prompt = promptRaw.length > 0 ? promptRaw : buildPromptFallback(e);
      const temperature = clampTemp(e?.temperature);
      if (!roleName || !prompt) {
        continue;
      }
      experts.push({ roleName, roleDescription, temperature, prompt });
    }
    if (experts.length === 0) {
      return { ok: false, error: "主持人编排失败：experts 为空或字段不完整" };
    }
    return { ok: true, value: { thoughtProcess: thoughtProcess.trim(), experts } };
  } catch (err) {
    return { ok: false, error: `主持人编排失败：JSON 解析失败：${String(err)}` };
  }
}

function parseReviewResultFromText(text: string): { ok: true; value: ReviewResult } | { ok: false; error: string } {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return { ok: false, error: "主持人复核失败：没有 JSON 输出" };
  }
  try {
    const parsed = JSON.parse(jsonText) as any;
    const satisfied = Boolean(parsed?.satisfied);
    const critique = typeof parsed?.critique === "string" ? parsed.critique.trim() : "";
    const nextRoundStrategy = typeof parsed?.nextRoundStrategy === "string" ? parsed.nextRoundStrategy.trim() : "";
    const raw = Array.isArray(parsed?.refinedExperts) ? parsed.refinedExperts : [];
    const refinedExperts: PlannedExpert[] = [];
    for (const e of raw) {
      const roleName = typeof e?.roleName === "string" ? e.roleName.trim() : "";
      const roleDescription = typeof e?.roleDescription === "string" ? e.roleDescription.trim() : "";
      const prompt = typeof e?.prompt === "string" ? e.prompt.trim() : "";
      const temperature = clampTemp(e?.temperature);
      if (!roleName || !prompt) {
        continue;
      }
      refinedExperts.push({ roleName, roleDescription, temperature, prompt });
    }
    return { ok: true, value: { satisfied, critique, nextRoundStrategy, refinedExperts } };
  } catch (err) {
    return { ok: false, error: `主持人复核失败：JSON 解析失败：${String(err)}` };
  }
}

function buildRoleAssignerSystemPrompt(): string {
  return `你是“专家团主持人”。
  你需要为一个用户问题，分配 N 位“专家角色”，用于并行讨论并最终优化成适合 code agent 的提示词。

  输出要求（非常重要）：
  - 你的整段输出必须是“唯一的、合法的 JSON 对象”（不要 Markdown，不要解释，不要前后缀文字）。
  - 输出必须以 "{" 开头，以 "}" 结尾。
  - 结构如下：
  {
    "roles": [
      { "name": "角色名称", "focus": "关注点/视角（简短）" }
  ]
}

  约束：
  - roles.length 必须等于 N
  - name 要具体、彼此差异化（例如：资深软件工程师/前端交互专家/后端协议/QA/安全/性能/UX 等）
  - focus 用一句话描述该专家关注点

  反例（禁止）：
  - 输出“下面给出…/协作流程/里程碑/清单”等长文
  - 输出 bullet 列表或 Markdown

  正例（示意，注意不要加任何多余文字）：
  {"roles":[{"name":"资深软件工程师","focus":"实现方案与风险点"},{"name":"产品经理","focus":"目标/边界/优先级"},{"name":"QA","focus":"验收标准与回归"}]}`;
}

function buildManagerPlanSystemPrompt(): string {
  return `你是“专家团主持人/编排引擎”。
你要把用户的原始问题，编排成 N 位专家并行讨论的任务，并为每位专家生成：
- role：角色名（短）
- description：该专家的侧重点（短）
- temperature：0.0-1.5（更严谨=低温，更发散=高温）
- prompt：发给该专家的用户指令（必须具体，可执行，包含上下文）

输出要求（非常重要）：
- 整段输出必须是“唯一的、合法的 JSON 对象”（不要 Markdown，不要解释，不要前后缀文字）。
- 输出必须以 "{" 开头，以 "}" 结尾。
- JSON 结构如下：
{
  "thought_process": "简短说明为什么选这些专家（1-3 句）",
  "experts": [
    { "role": "xxx", "description": "xxx", "temperature": 0.7, "prompt": "..." }
  ]
}

约束：
- experts.length 必须等于 N
- prompt 禁止输出“请选一个编号开始 / 选项 1/2/3 让用户选择”这类交互，必须选一个默认推荐方案并推进
- prompt 必须围绕“把问题优化成 code agent 可执行提示词”，最终要能产出可直接执行的工程任务提示词`;
}

function buildManagerPlanUserPrompt(transcript: string, n: number, meta: { scope: "local" | "remote"; workspaceRoot: string }): string {
  const rootLine = meta.workspaceRoot.trim() ? `- workspaceRoot: ${meta.workspaceRoot.trim()}` : `- workspaceRoot: （未选择）`;
  return `用户问题/目标如下：

${transcript}

上下文：
- scope: ${meta.scope}
${rootLine}

请编排 N=${n} 位专家。`;
}

function buildManagerReviewSystemPrompt(): string {
  return `你是“质量复核与编排引擎（主持人）”。
你刚收到一组专家输出。你的任务是判断：这些输出是否足够生成高质量的“最终提示词”（给 code agent 执行）。

如果不满意：
- 解释具体缺口（critique）
- 给下一轮策略（nextRoundStrategy）
- 输出 refinedExperts（下一轮专家列表，必须把 critique 融入每个 prompt 里）

如果满意：
- satisfied=true
- refinedExperts=[]

输出要求（非常重要）：
- 整段输出必须是唯一合法 JSON（不要 Markdown/解释）。
- 结构如下：
{
  "satisfied": boolean,
  "critique": "缺口说明",
  "nextRoundStrategy": "下一轮策略（可空）",
  "refinedExperts": [
    { "roleName": "xxx", "roleDescription": "xxx", "temperature": 0.7, "prompt": "..." }
  ]
}`;
}

function buildManagerReviewUserPrompt(transcript: string, experts: ExpertResult[], n: number): string {
  const outputs = experts
    .map((e) => `--- [Round ${e.round}] ${e.roleName} ---\n${(e.text || "").trim().slice(0, 2500)}`)
    .join("\n\n");
  return `原始问题/目标：

${transcript}

当前专家输出（共 ${experts.length} 条，期望下一轮最多补充 ${n} 位专家）：

${outputs}
`;
}

function buildRoleAssignerUserPrompt(transcript: string, n: number): string {
  return `用户问题/目标如下：

${transcript}

请分配 N=${n} 位专家角色。`;
}

function buildExpertSystemPrompt(roleName: string, roleDescription: string): string {
  const desc = roleDescription.trim();
  const descLine = desc ? `\n你的侧重点：${desc}` : "";
  return `你是一个“${roleName}”。${descLine}
你正在帮助用户把一个问题，改写成适合“代码 Agent（Codex CLI / code agent）”执行的高质量提示词。

输出要求：
- 用中文。
- 不要输出思考过程，只输出可执行建议。
- 请用 Markdown 输出，必须包含这些小节（顺序一致）：
  1) 需要澄清的问题（最多 5 条；放在最后也行，但不要变成“让用户选编号”）
  2) 关键约束/风险（要点列表）
  3) 建议的最终提示词（给 code agent 的指令，放在 Markdown 代码块里）
  4) 验收标准/自测（要点列表）

强约束（很重要）：
- 不要输出“请选一个编号开始 / 选项 1/2/3 让用户选择”这类交互。
- 如果存在多种实现路径：你必须选一个“默认推荐方案”并给出理由；其它方案最多一行作为备选，不要展开成问卷。
- 即使用户输入信息很少，也要先给出“可执行的默认假设”并产出一份可运行的提示词。
`;
}

function buildExpertUserPrompt(transcript: string, workspaceRoot: string, scope: "local" | "remote"): string {
  const rootLine = workspaceRoot.trim() ? `- workspaceRoot: ${workspaceRoot.trim()}` : `- workspaceRoot: （未选择）`;
  return `用户的问题/目标如下：

${transcript}

上下文：
- scope: ${scope}
${rootLine}

请按要求给出建议。`;
}

function buildSummarizerSystemPrompt(): string {
  return `你是“专家团主持人/主编”。
你会收到多位专家对同一问题给出的建议，请合并去重并产出最终版本，目标是：生成一个可以直接发给“代码 Agent（Codex CLI / code agent）”的提示词。

输出要求（中文、Markdown）：
- 先给出：最终提示词（一个代码块；这是唯一会被发送给 code agent 的正文）
- 再给出：关键假设/约束（要点，尽量完整；不要太短，至少 6 条要点）
- 再给出：验收标准（要点，至少 6 条要点）
- 最后给出：仍需澄清的问题（最多 5 条；不影响先执行）

注意：
- 不要输出思考过程。
- 禁止输出“请选一个编号/先回答问题再开始/选项 1/2/3”这类交互。
- 如果专家给了多个方案：你必须选一个“默认推荐方案”并写进最终提示词里；其它方案最多一行作为备选。
- 最终提示词必须具体，至少包含：
  - 目标/范围（明确做什么、不做什么）
  - 需要改动的模块/文件范围（可以是猜测，但要具体）
  - 分步计划（步骤化、可执行）
  - 需要运行的命令/测试
  - 回滚点/风险点
  - 完成标准（与验收标准一致）

反例（禁止）：
- “请选一个编号开始”
- “你更喜欢 A 还是 B？”
- “先确认 5 个问题，否则无法继续”

正例（要学这种风格）：
- “默认按 X 方案实现；若你确认 Y 再扩展到 Z”
- “即使缺信息，也先基于假设完成一个可跑通的最小闭环”。`;
}

function buildSummarizerUserPrompt(
  transcript: string,
  experts: ExpertResult[],
  meta: { scope: "local" | "remote"; workspaceRoot: string; assignedRoles: string[] }
): string {
  const blocks = experts
    .map((e) => {
      const header = `### ${e.roleName}（${e.ok ? "OK" : "ERROR"}）`;
      const body = e.ok ? e.text.trim() : `（失败：${e.error ?? "unknown"}）`;
      return `${header}\n\n${body}`;
    })
    .join("\n\n");

  const rootLine = meta.workspaceRoot.trim() ? `- workspaceRoot: ${meta.workspaceRoot.trim()}` : `- workspaceRoot: （未选择）`;
  const assigned = meta.assignedRoles.length > 0 ? meta.assignedRoles.join("\n") : "（未提供）";

  return `原始问题/目标：

${transcript}

上下文：
- scope: ${meta.scope}
${rootLine}
- 专家角色：
${assigned}

专家建议如下：

${blocks}
`;
}

function extractFinalPromptFromSummary(summary: string): string {
  const text = summary.trim();
  if (!text) {
    return "";
  }
  const start = text.indexOf("```");
  if (start < 0) {
    return text;
  }
  const end = text.indexOf("```", start + 3);
  if (end < 0) {
    return text;
  }
  const inner = text.slice(start + 3, end);
  return inner.trim() || text;
}

function buildSendText(mode: SendMode, originalTranscript: string, summary: string): string {
  const finalPrompt = extractFinalPromptFromSummary(summary);
  if (mode === "finalOnly") {
    return finalPrompt.trim();
  }
  if (mode === "finalWithContext") {
    const ctx = originalTranscript.trim();
    return `原始问题/目标：\n${ctx || "（无）"}\n\n最终提示词：\n\n${finalPrompt.trim()}`;
  }
  return summary.trim();
}

const Renderer: React.FC<SkillCustomRenderProps> = (props) => {
  const [turnDraft, setTurnDraft] = useState<string>("");
  const [turns, setTurns] = useState<string[]>([]);

  const [roleMode, setRoleMode] = useState<RoleMode>("auto");
  const [rolesText, setRolesText] = useState<string>(defaultRolesText());
  const [expertCount, setExpertCount] = useState<number>(3);
  const [assignedRoles, setAssignedRoles] = useState<AssignedRole[]>([]);
  const [assignedForTranscript, setAssignedForTranscript] = useState<string>("");
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assignRaw, setAssignRaw] = useState<string>("");
  const [managerThoughtProcess, setManagerThoughtProcess] = useState<string>("");
  const [managerPlan, setManagerPlan] = useState<ManagerPlan | null>(null);
  const [enableRecursiveLoop, setEnableRecursiveLoop] = useState<boolean>(true);
  const [maxRounds, setMaxRounds] = useState<number>(2);
  const [reviewLog, setReviewLog] = useState<string>("");

  const [model, setModel] = useState<string>("");
  const [temperature, setTemperature] = useState<number>(0.2);
  const [autoSummarize, setAutoSummarize] = useState<boolean>(true);

  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const [experts, setExperts] = useState<ExpertResult[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [summarizePrompts, setSummarizePrompts] = useState<{ system: string; user: string } | null>(null);

  const [sendMode, setSendMode] = useState<SendMode>("finalOnly");
  const [savePath, setSavePath] = useState<string>("docs/优化提示词.md");
  const [saved, setSaved] = useState<string | null>(null);

  const transcript = useMemo(() => buildTranscript(turns), [turns]);
  const roleNames = useMemo(() => {
    return rolesText
      .split(/\r?\n/g)
      .map((l) => l.trim())
      .filter(Boolean);
  }, [rolesText]);

  const resolvedAssignedRoleNames = useMemo(() => {
    return assignedRoles
      .map((r) => {
        const name = r.name.trim();
        const focus = r.focus.trim();
        if (!name) {
          return "";
        }
        return focus ? `${name}（${focus}）` : name;
      })
      .filter(Boolean);
  }, [assignedRoles]);

  const transcriptKey = transcript.trim();
  const assignedStale = assignedForTranscript.trim().length > 0 && assignedForTranscript !== transcriptKey;
  const canDiscuss =
    transcriptKey.length > 0 &&
    !busy &&
    (roleMode === "manual" ? roleNames.length > 0 : clampInt(expertCount, 1, 8) > 0);
  const canSummarize = experts.length > 0 && !busy;

  async function planExpertsForTranscript(
    t: string
  ): Promise<{ ok: true; plan: ManagerPlan; roles: AssignedRole[] } | { ok: false; error: string }> {
    setAssignError(null);
    setAssignRaw("");
    setManagerThoughtProcess("");
    setManagerPlan(null);
    const n = clampInt(expertCount, 1, 8);
    try {
      const system = buildManagerPlanSystemPrompt();
      const user = buildManagerPlanUserPrompt(t, n, { scope: props.scope, workspaceRoot: props.workspaceRoot });

      async function attempt(extraUserPrefix: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
        try {
          const res = await props.llmChatComplete({
            model: model.trim() || undefined,
            temperature: 0,
            maxOutputTokens: 900,
            messages: [
              { role: "system", content: system },
              { role: "user", content: `${extraUserPrefix}${user}`.trim() }
            ]
          });
          if (!res.ok) {
            return { ok: false, error: res.error ?? "llmChatComplete failed" };
          }
          return { ok: true, text: res.text.trim() };
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      }

      const attempts: string[] = [];
      const errors: string[] = [];

      const first = await attempt("");
      if (first.ok) {
        attempts.push(first.text);
        const parsed = parsePlannedExpertsFromText(first.text);
        if (parsed.ok) {
          const plan = parsed.value;
          const experts = plan.experts.slice(0, n);
          if (experts.length === n) {
            const roles: AssignedRole[] = experts.map((e) => ({ name: e.roleName, focus: e.roleDescription }));
            setAssignRaw(first.text);
            setManagerThoughtProcess(plan.thoughtProcess);
            setManagerPlan({ thoughtProcess: plan.thoughtProcess, experts });
            setAssignedRoles(roles);
            setAssignedForTranscript(t);
            return { ok: true, plan: { thoughtProcess: plan.thoughtProcess, experts }, roles };
          }
        }
      } else {
        errors.push(`(Attempt 1) ${first.error}`);
      }

      const second = await attempt(
        "你上一次输出不符合要求。现在必须严格只输出 JSON，字段只允许 thought_process 与 experts，不得包含任何其它文字。\n\n"
      );
      if (second.ok) {
        attempts.push(second.text);
        const parsed = parsePlannedExpertsFromText(second.text);
        if (parsed.ok) {
          const plan = parsed.value;
          const experts = plan.experts.slice(0, n);
          if (experts.length === n) {
            const roles: AssignedRole[] = experts.map((e) => ({ name: e.roleName, focus: e.roleDescription }));
            setAssignRaw(attempts.join("\n\n---\n\n"));
            setManagerThoughtProcess(plan.thoughtProcess);
            setManagerPlan({ thoughtProcess: plan.thoughtProcess, experts });
            setAssignedRoles(roles);
            setAssignedForTranscript(t);
            return { ok: true, plan: { thoughtProcess: plan.thoughtProcess, experts }, roles };
          }
        }
      } else {
        errors.push(`(Attempt 2) ${second.error}`);
      }

      if (attempts.length > 0) {
        setAssignRaw(attempts.join("\n\n---\n\n"));
      }
      if (errors.length > 0) {
        setAssignRaw(errors.join("\n"));
        return { ok: false, error: `主持人编排失败：${errors[0]}` };
      }
      return { ok: false, error: "主持人编排失败：未能得到符合 JSON 结构的 N 个专家" };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async function runDiscussion(): Promise<void> {
    setBusy(true);
    setError(null);
    setAssignError(null);
    setSaved(null);
    setExperts([]);
    setSummary("");
    setSummarizePrompts(null);
    setReviewLog("");

    const t = transcriptKey;
    if (!t) {
      setBusy(false);
      setError("请先在“议题”里输入内容并加入");
      return;
    }

    try {
      const n = clampInt(expertCount, 1, 8);
      const all: ExpertResult[] = [];

      async function runRound(round: number, planned: PlannedExpert[]): Promise<void> {
        const results = await Promise.all(
          planned.map(async (spec, idx): Promise<ExpertResult> => {
            const id = `expert_r${round}_${idx + 1}`;
            const roleName = spec.roleName;
            const roleDescription = spec.roleDescription;
            const systemPrompt = buildExpertSystemPrompt(roleName, roleDescription);
            const userPrompt = spec.prompt.trim().length > 0 ? spec.prompt.trim() : buildExpertUserPrompt(t, props.workspaceRoot, props.scope);
            try {
              const res = await props.llmChatComplete({
                model: model.trim() || undefined,
                temperature: spec.temperature,
                maxOutputTokens: 1800,
                messages: [
                  { role: "system", content: systemPrompt },
                  { role: "user", content: userPrompt }
                ]
              });
              if (!res.ok) {
                return {
                  id,
                  roleName,
                  roleDescription,
                  temperature: spec.temperature,
                  round,
                  ok: false,
                  text: "",
                  error: res.error ?? "请求失败",
                  systemPrompt,
                  userPrompt
                };
              }
              return {
                id,
                roleName,
                roleDescription,
                temperature: spec.temperature,
                round,
                ok: true,
                text: res.text.trim(),
                error: null,
                systemPrompt,
                userPrompt
              };
            } catch (err) {
              return {
                id,
                roleName,
                roleDescription,
                temperature: spec.temperature,
                round,
                ok: false,
                text: "",
                error: String(err),
                systemPrompt,
                userPrompt
              };
            }
          })
        );
        all.push(...results);
        setExperts(all.slice());
      }

      let round = 1;
      let plannedRound: PlannedExpert[] = [];

      if (roleMode === "manual") {
        plannedRound = roleNames.map((name) => ({
          roleName: name,
          roleDescription: "",
          temperature: clampTemp(temperature),
          prompt: buildExpertUserPrompt(t, props.workspaceRoot, props.scope)
        }));
      } else {
        const usablePlan = !assignedStale && managerPlan ? managerPlan : null;
        const planRes = usablePlan ? { ok: true as const, plan: usablePlan } : await planExpertsForTranscript(t);
        if (!planRes.ok) {
          setAssignError(planRes.error);
          return;
        }
        plannedRound = planRes.plan.experts.slice(0, n);
      }

      await runRound(round, plannedRound);

      const maxR = clampInt(maxRounds, 1, 3);
      while (enableRecursiveLoop && round < maxR) {
        const system = buildManagerReviewSystemPrompt();
        const user = buildManagerReviewUserPrompt(t, all, n);
        const resp = await props.llmChatComplete({
          model: model.trim() || undefined,
          temperature: 0,
          maxOutputTokens: 900,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        });

        if (!resp.ok) {
          setReviewLog((prev) => `${prev}\n\n--- Review (Round ${round}) ERROR ---\n${resp.error ?? "unknown"}`.trim());
          break;
        }

        const raw = resp.text.trim();
        const parsed = parseReviewResultFromText(raw);
        setReviewLog((prev) => `${prev}\n\n--- Review (Round ${round}) ---\n${raw}`.trim());
        if (!parsed.ok) {
          break;
        }
        if (parsed.value.satisfied || parsed.value.refinedExperts.length === 0) {
          break;
        }

        round += 1;
        plannedRound = parsed.value.refinedExperts.slice(0, n);
        await runRound(round, plannedRound);
      }

      if (autoSummarize) {
        await runSummarize(t, all);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function runSummarize(currentTranscript?: string, currentExperts?: ExpertResult[]): Promise<void> {
    setError(null);
    setSaved(null);

    const t = (currentTranscript ?? transcript).trim();
    const es = currentExperts ?? experts;
    if (!t) {
      setError("议题为空");
      return;
    }
    if (es.length === 0) {
      setError("还没有专家输出，请先开始讨论");
      return;
    }

    setBusy(true);
    try {
      const system = buildSummarizerSystemPrompt();
      const usedRoles = Array.from(
        new Set(
          es
            .map((e) => {
              const name = e.roleName.trim();
              const desc = e.roleDescription.trim();
              if (!name) {
                return "";
              }
              return desc ? `${name}（${desc}）` : name;
            })
            .filter(Boolean)
        )
      );
      const user = buildSummarizerUserPrompt(t, es, {
        scope: props.scope,
        workspaceRoot: props.workspaceRoot,
        assignedRoles: usedRoles
      });
      setSummarizePrompts({ system, user });
      const res = await props.llmChatComplete({
        model: model.trim() || undefined,
        temperature: 0.2,
        maxOutputTokens: 1800,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      });
      if (!res.ok) {
        setError(res.error ?? "汇总失败");
        return;
      }
      setSummary(res.text.trim());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    setError(null);
    setSaved(null);

    const content = summary.trim();
    if (!content) {
      setError("还没有汇总输出");
      return;
    }
    const res = await props.saveToWorkspaceFile(savePath, content);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(res.absPath);
  }

  const sendText = useMemo(() => buildSendText(sendMode, transcript, summary), [sendMode, transcript, summary]);
  const canUseSummary = summary.trim().length > 0 && !busy;

  return (
    <div className="skillCustom">
      <div className="skillWizardField">
        <div className="skillWizardLabel">议题（内部对话）</div>
        <textarea
          className="skillWizardInput"
          rows={3}
          value={turnDraft}
          onChange={(e) => setTurnDraft(e.target.value)}
          placeholder="输入你的问题/需求/目标，点“加入议题”。可以加入多条作为上下文。"
        />
        <div className="skillWizardActions" style={{ justifyContent: "flex-start" }}>
          <button
            className="btn tiny"
            onClick={() => {
              const t = turnDraft.trim();
              if (!t) {
                return;
              }
              setTurns((prev) => [...prev, t]);
              setAssignedForTranscript("");
              setTurnDraft("");
            }}
            disabled={busy || turnDraft.trim().length === 0}
            type="button"
          >
            加入议题
          </button>
          <button
            className="btn tiny"
            onClick={() => {
              setTurns([]);
              setTurnDraft("");
              setExperts([]);
              setSummary("");
              setError(null);
              setAssignError(null);
              setSaved(null);
              setAssignedRoles([]);
              setAssignedForTranscript("");
            }}
            disabled={busy}
            type="button"
          >
            清空
          </button>
          <span className="hint">{`当前：${turns.length} 条`}</span>
        </div>
        {turns.length > 0 ? (
          <div className="skillWizardPreview">
            {turns.map((t, idx) => (
              <div key={`${idx}`} style={{ marginBottom: 8 }}>
                <div className="hint">{`第 ${idx + 1} 条`}</div>
                <div>{t}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="skillWizardField">
        <div className="skillWizardLabel">专家角色（由主持人分配）</div>
        <div className="skillWizardActions" style={{ justifyContent: "flex-start" }}>
          <select className="skillWizardInput" value={roleMode} onChange={(e) => setRoleMode(e.target.value as RoleMode)}>
            <option value="auto">自动分配（推荐）</option>
            <option value="manual">手动指定</option>
          </select>
        </div>

        {roleMode === "auto" ? (
          <>
            <div className="skillWizardField">
              <div className="skillWizardLabel">专家数量</div>
              <input
                className="skillWizardInput"
                type="number"
                min={1}
                max={8}
                value={expertCount}
                onChange={(e) => {
                  setExpertCount(Number(e.target.value));
                  setAssignedRoles([]);
                  setAssignedForTranscript("");
                }}
              />
            </div>

            <div className="skillWizardActions" style={{ justifyContent: "flex-start" }}>
              <button
                className="btn tiny"
                onClick={() => void (async () => {
                  const t = transcriptKey;
                  if (!t) {
                    setAssignError("议题为空，无法编排专家");
                    return;
                  }
                  setBusy(true);
                  try {
                    const res = await planExpertsForTranscript(t);
                    if (!res.ok) {
                      setAssignError(res.error);
                    }
                  } finally {
                    setBusy(false);
                  }
                })()}
                disabled={busy || transcriptKey.length === 0}
                type="button"
              >
                {busy ? "处理中…" : "主持人编排专家"}
              </button>
              {assignedStale ? <span className="hint">（议题已变化，建议重新分配）</span> : null}
            </div>

            {assignError ? <div className="errorText">{assignError}</div> : null}

            {resolvedAssignedRoleNames.length > 0 ? (
              <div className="skillWizardPreview">
                {resolvedAssignedRoleNames.map((r, idx) => (
                  <div key={`${idx}`} className="hint">
                    {`#${idx + 1} ${r}`}
                  </div>
                ))}
              </div>
            ) : (
              <div className="hint">尚未编排专家；点击“主持人编排专家”，或直接点“开始讨论”（会自动编排）。</div>
            )}
          </>
        ) : (
          <>
            <textarea
              className="skillWizardInput"
              rows={3}
              value={rolesText}
              onChange={(e) => setRolesText(e.target.value)}
              placeholder="例如：资深软件工程师（实现与风险）\n产品经理（目标与边界）\n测试/QA（验收与回归）"
            />
            <div className="hint">手动模式下，每行一个专家角色名称。</div>
          </>
        )}
      </div>

      <div className="skillWizardField">
        <div className="skillWizardLabel">模型（可选）</div>
        <input
          className="skillWizardInput"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="留空=使用当前配置的默认模型"
        />
      </div>

      <div className="skillWizardField">
        <div className="skillWizardLabel">温度（temperature）</div>
        <input
          className="skillWizardInput"
          type="number"
          min={0}
          max={1}
          step={0.1}
          value={temperature}
          onChange={(e) => setTemperature(Number(e.target.value))}
        />
      </div>

      <div className="skillWizardField">
        <div className="skillWizardLabel">自动汇总</div>
        <select
          className="skillWizardInput"
          value={autoSummarize ? "on" : "off"}
          onChange={(e) => setAutoSummarize(e.target.value === "on")}
        >
          <option value="on">讨论结束后自动汇总</option>
          <option value="off">只生成专家输出（手动点汇总）</option>
        </select>
      </div>

      <div className="skillWizardField">
        <div className="skillWizardLabel">递归复核（参考 Prisma）</div>
        <div className="skillWizardActions" style={{ justifyContent: "flex-start" }}>
          <select
            className="skillWizardInput"
            value={enableRecursiveLoop ? "on" : "off"}
            onChange={(e) => setEnableRecursiveLoop(e.target.value === "on")}
          >
            <option value="on">开启（主持人会复核并追加一轮专家）</option>
            <option value="off">关闭</option>
          </select>
          <input
            className="skillWizardInput"
            style={{ width: 120 }}
            type="number"
            min={1}
            max={3}
            value={maxRounds}
            onChange={(e) => setMaxRounds(Number(e.target.value))}
            title="最多轮数（包含第一轮）"
          />
        </div>
        <div className="hint">最多 3 轮；开启后能减少“让你选编号/问卷式输出”的概率。</div>
      </div>

      <div className="skillWizardActions" style={{ justifyContent: "flex-start" }}>
        <button className="btn tiny primary" onClick={() => void runDiscussion()} disabled={!canDiscuss} type="button">
          {busy
            ? "讨论中…"
            : `开始讨论（${
                roleMode === "manual" ? roleNames.length : resolvedAssignedRoleNames.length || clampInt(expertCount, 1, 8)
              } 位专家）`}
        </button>
        <button className="btn tiny" onClick={() => void runSummarize()} disabled={!canSummarize} type="button">
          {busy ? "处理中…" : "汇总"}
        </button>
      </div>

      {error ? <div className="errorText">{error}</div> : null}

      {experts.length > 0 ? (
        <div className="skillWizardResult">
          <div className="skillWizardResultHeader">
            <div className="skillWizardResultTitle">专家输出</div>
          </div>
          <div className="skillWizardPreview">
            {experts.map((e) => (
              <div key={e.id} style={{ marginBottom: 12 }}>
                <div className="hint">{`[Round ${e.round}] ${e.roleName} · temp=${e.temperature} · ${e.ok ? "OK" : "失败"}`}</div>
                <div>{e.ok ? e.text : `（失败：${e.error ?? "unknown"}）`}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="skillWizardResult">
        <div className="skillWizardResultHeader">
          <div className="skillWizardResultTitle">汇总（给 code agent 的最终提示词）</div>
          <div className="skillWizardActions">
            <select className="skillWizardInput" value={sendMode} onChange={(e) => setSendMode(e.target.value as SendMode)}>
              <option value="finalOnly">发送：仅最终提示词</option>
              <option value="finalWithContext">发送：带原始问题</option>
              <option value="full">发送：完整汇总</option>
            </select>
            <button className="btn tiny" onClick={() => props.insertText(sendText)} disabled={!canUseSummary} type="button">
              插入
            </button>
            <button className="btn tiny primary" onClick={() => void props.sendText(sendText)} disabled={!canUseSummary} type="button">
              发送
            </button>
          </div>
        </div>

        <div className="skillWizardField" style={{ marginTop: 8 }}>
          <div className="skillWizardLabel">保存路径（相对工作区）</div>
          <input className="skillWizardInput" value={savePath} onChange={(e) => setSavePath(e.target.value)} />
        </div>
        <div className="skillWizardActions" style={{ marginTop: 8 }}>
          <button className="btn tiny" onClick={() => void save()} disabled={!canUseSummary} type="button">
            保存
          </button>
          {saved ? <span className="hint">{`已保存：${saved}`}</span> : null}
        </div>

        <div className="skillWizardPreview">{summary ? summary : "（尚未汇总）"}</div>
      </div>

      <details style={{ marginTop: 10 }}>
        <summary className="hint">查看全过程（主持人编排/专家讨论/复核/汇总）</summary>
        <div className="hint" style={{ marginTop: 8 }}>
          说明：这里展示的是技能内部调用 AI 的提示词与输出，方便你调试；不会自动发送到对话页面。
        </div>
        <div className="skillWizardResult" style={{ marginTop: 8 }}>
          <div className="skillWizardResultHeader">
            <div className="skillWizardResultTitle">主持人编排专家（Plan）</div>
          </div>
          <div className="skillWizardPreview">
            <div className="hint">编排思路</div>
            {managerThoughtProcess.trim().length ? managerThoughtProcess.trim() : "（无）"}
            <div className="hint" style={{ marginTop: 8 }}>
              当前编排
            </div>
            {resolvedAssignedRoleNames.length > 0 ? resolvedAssignedRoleNames.join("\n") : "（尚未编排）"}
            <div className="hint" style={{ marginTop: 8 }}>
              原始输出
            </div>
            {assignRaw ? assignRaw : "（无）"}
          </div>
        </div>

        <div className="skillWizardResult" style={{ marginTop: 10 }}>
          <div className="skillWizardResultHeader">
            <div className="skillWizardResultTitle">主持人复核（Review）</div>
          </div>
          <div className="skillWizardPreview">{reviewLog.trim().length ? reviewLog.trim() : "（未开启或尚未复核）"}</div>
        </div>

        <div className="skillWizardResult" style={{ marginTop: 10 }}>
          <div className="skillWizardResultHeader">
            <div className="skillWizardResultTitle">专家团讨论（每位专家的提示词与输出）</div>
          </div>
          {experts.length > 0 ? (
            <div className="skillWizardPreview">
              {experts.map((e) => (
                <details key={e.id} style={{ marginBottom: 10 }}>
                  <summary className="hint">{`[Round ${e.round}] ${e.roleName} · temp=${e.temperature} · ${e.ok ? "OK" : "失败"}`}</summary>
                  <div className="hint" style={{ marginTop: 8 }}>
                    SYSTEM
                  </div>
                  <div className="skillWizardPreview">{e.systemPrompt}</div>
                  <div className="hint" style={{ marginTop: 8 }}>
                    USER
                  </div>
                  <div className="skillWizardPreview">{e.userPrompt}</div>
                  <div className="hint" style={{ marginTop: 8 }}>
                    输出
                  </div>
                  <div className="skillWizardPreview">{e.ok ? e.text : `（失败：${e.error ?? "unknown"}）`}</div>
                </details>
              ))}
            </div>
          ) : (
            <div className="hint">（尚未开始讨论）</div>
          )}
        </div>

        <div className="skillWizardResult" style={{ marginTop: 10 }}>
          <div className="skillWizardResultHeader">
            <div className="skillWizardResultTitle">汇总（主持人的提示词与输出）</div>
          </div>
          {summarizePrompts ? (
            <>
              <div className="hint" style={{ marginTop: 8 }}>
                SYSTEM
              </div>
              <div className="skillWizardPreview">{summarizePrompts.system}</div>
              <div className="hint" style={{ marginTop: 8 }}>
                USER
              </div>
              <div className="skillWizardPreview">{summarizePrompts.user}</div>
            </>
          ) : (
            <div className="hint">（尚未汇总）</div>
          )}
          <div className="hint" style={{ marginTop: 8 }}>
            输出
          </div>
          <div className="skillWizardPreview">{summary ? summary : "（无）"}</div>
        </div>
      </details>
    </div>
  );
};

const manifest: SkillCustomManifestV1 = {
  schemaVersion: 1,
  id: "prompt_optimizer",
  title: "优化提示词",
  description: "专家团多 Agent 讨论 + 主持人汇总，一键把问题变成 code agent 可执行的提示词。",
  version: "0.1.0",
  kind: "custom",
  Renderer
};

export default manifest;
