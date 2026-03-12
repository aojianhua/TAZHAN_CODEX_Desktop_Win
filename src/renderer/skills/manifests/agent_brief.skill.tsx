import React, { useMemo, useState } from "react";

import type { SkillCustomManifestV1, SkillCustomRenderProps } from "../types";

function buildPrompt(input: {
  task: string;
  scope: "local" | "remote";
  workspaceRoot: string;
  repoNotes: string;
  constraints: string;
  preferredStyle: string;
}): { system: string; user: string } {
  const system = `You are an expert software engineer acting as a coding agent.
Your job: produce an actionable implementation brief for a code agent (Codex CLI).
Output must be concise but concrete, in Chinese, in Markdown.

Requirements:
- Start with a short goal.
- Then list: key assumptions/questions, plan steps, expected file touch-points, tests to run, risks/rollback.
- Prefer explicit commands, file paths, and acceptance criteria.
- Avoid fluff.`;

  const user = `任务描述：
${input.task.trim()}

当前会话信息：
- scope: ${input.scope}
- workspaceRoot: ${input.workspaceRoot || "（未选择）"}

仓库/模块备注（可选）：
${input.repoNotes.trim() || "（无）"}

约束（可选）：
${input.constraints.trim() || "（无）"}

输出偏好（可选）：
${input.preferredStyle.trim() || "（无）"}
`;

  return { system, user };
}

const Renderer: React.FC<SkillCustomRenderProps> = (props) => {
  const [task, setTask] = useState<string>("");
  const [repoNotes, setRepoNotes] = useState<string>("");
  const [constraints, setConstraints] = useState<string>("");
  const [preferredStyle, setPreferredStyle] = useState<string>("尽量贴近本项目已有规范；如果需要跑命令，给出具体命令。");
  const [model, setModel] = useState<string>("");

  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<string>("");

  const [savePath, setSavePath] = useState<string>("docs/agent_brief.md");
  const [saved, setSaved] = useState<string | null>(null);

  const promptPreview = useMemo(() => {
    const p = buildPrompt({
      task,
      scope: props.scope,
      workspaceRoot: props.workspaceRoot,
      repoNotes,
      constraints,
      preferredStyle
    });
    return `SYSTEM:\n${p.system}\n\nUSER:\n${p.user}`.trimEnd();
  }, [task, repoNotes, constraints, preferredStyle, props.scope, props.workspaceRoot]);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const p = buildPrompt({
        task,
        scope: props.scope,
        workspaceRoot: props.workspaceRoot,
        repoNotes,
        constraints,
        preferredStyle
      });
      const res = await props.llmChatComplete({
        model: model.trim() || undefined,
        temperature: 0.2,
        maxOutputTokens: 1800,
        messages: [
          { role: "system", content: p.system },
          { role: "user", content: p.user }
        ]
      });
      if (!res.ok) {
        setError(res.error ?? "生成失败");
        return;
      }
      setOutput(res.text.trim());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    setError(null);
    setSaved(null);
    const res = await props.saveToWorkspaceFile(savePath, output);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setSaved(res.absPath);
  }

  const canGenerate = task.trim().length > 0 && !busy;
  const canUseOutput = output.trim().length > 0 && !busy;

  return (
    <div className="skillCustom">
      <div className="skillWizardField">
        <div className="skillWizardLabel">任务描述 *</div>
        <textarea
          className="skillWizardInput"
          rows={4}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="例如：把远端会话列表空白的问题修掉；调整连接流程像 ssh；并更新 UI。"
        />
      </div>

      <div className="skillWizardField">
        <div className="skillWizardLabel">仓库/模块备注（可选）</div>
        <textarea
          className="skillWizardInput"
          rows={2}
          value={repoNotes}
          onChange={(e) => setRepoNotes(e.target.value)}
          placeholder="例如：只改 tazhan-desktop；不要动 codex-rs；UI 走 skills 弹窗。"
        />
      </div>

      <div className="skillWizardField">
        <div className="skillWizardLabel">约束（可选）</div>
        <textarea
          className="skillWizardInput"
          rows={2}
          value={constraints}
          onChange={(e) => setConstraints(e.target.value)}
          placeholder="例如：必须兼容远端/本地；不能引入新依赖；完成后跑 pnpm -C tazhan-desktop typecheck/test。"
        />
      </div>

      <div className="skillWizardField">
        <div className="skillWizardLabel">输出偏好（可选）</div>
        <input className="skillWizardInput" value={preferredStyle} onChange={(e) => setPreferredStyle(e.target.value)} />
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

      <div className="skillWizardActions" style={{ justifyContent: "flex-start" }}>
        <button className="btn tiny primary" onClick={() => void generate()} disabled={!canGenerate} type="button">
          {busy ? "生成中…" : "生成 Agent Brief"}
        </button>
        <button className="btn tiny" onClick={() => setOutput("")} disabled={busy} type="button">
          清空输出
        </button>
      </div>

      {error ? <div className="errorText">{error}</div> : null}

      <div className="skillWizardResult">
        <div className="skillWizardResultHeader">
          <div className="skillWizardResultTitle">输出</div>
          <div className="skillWizardActions">
            <button className="btn tiny" onClick={() => props.insertText(output)} disabled={!canUseOutput} type="button">
              插入
            </button>
            <button className="btn tiny primary" onClick={() => void props.sendText(output)} disabled={!canUseOutput} type="button">
              发送
            </button>
          </div>
        </div>

        <div className="skillWizardField" style={{ marginTop: 8 }}>
          <div className="skillWizardLabel">保存路径（相对工作区）</div>
          <input className="skillWizardInput" value={savePath} onChange={(e) => setSavePath(e.target.value)} />
        </div>
        <div className="skillWizardActions" style={{ marginTop: 8 }}>
          <button className="btn tiny" onClick={() => void save()} disabled={!canUseOutput} type="button">
            保存
          </button>
          {saved ? <span className="hint">{`已保存：${saved}`}</span> : null}
        </div>

        <div className="skillWizardPreview">{output ? output : "（尚未生成）"}</div>
      </div>

      <details style={{ marginTop: 8 }}>
        <summary className="hint">查看提示词（调试用）</summary>
        <div className="skillWizardPreview">{promptPreview}</div>
      </details>
    </div>
  );
};

const manifest: SkillCustomManifestV1 = {
  schemaVersion: 1,
  id: "agent_brief",
  title: "Agent Brief",
  description: "用 AI 把任务描述转成可执行的改动计划（适合发给 code agent）。",
  version: "0.1.0",
  kind: "custom",
  Renderer
};

export default manifest;
