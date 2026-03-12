import React, { useMemo, useState } from "react";

import type { SkillCustomManifestV1, SkillCustomRenderProps } from "../types";

type Mode = "trim" | "upper" | "lower" | "jsonPretty";

function transform(mode: Mode, input: string): { ok: true; text: string } | { ok: false; error: string } {
  if (mode === "trim") {
    return { ok: true, text: input.trim() };
  }
  if (mode === "upper") {
    return { ok: true, text: input.toUpperCase() };
  }
  if (mode === "lower") {
    return { ok: true, text: input.toLowerCase() };
  }
  if (mode === "jsonPretty") {
    const raw = input.trim();
    if (!raw) {
      return { ok: true, text: "" };
    }
    try {
      const parsed = JSON.parse(raw);
      return { ok: true, text: JSON.stringify(parsed, null, 2) };
    } catch (err) {
      return { ok: false, error: `JSON 解析失败：${String(err)}` };
    }
  }
  return { ok: true, text: input };
}

const Renderer: React.FC<SkillCustomRenderProps> = (props) => {
  const [mode, setMode] = useState<Mode>("jsonPretty");
  const [input, setInput] = useState<string>("");
  const [savePath, setSavePath] = useState<string>("docs/text_tools.md");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const output = useMemo(() => {
    const res = transform(mode, input);
    if (!res.ok) {
      return "";
    }
    return res.text;
  }, [mode, input]);

  const outputError = useMemo(() => {
    const res = transform(mode, input);
    return res.ok ? null : res.error;
  }, [mode, input]);

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

  return (
    <div className="skillCustom">
      <div className="skillWizardField">
        <div className="skillWizardLabel">模式</div>
        <select className="skillWizardInput" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          <option value="jsonPretty">JSON 美化</option>
          <option value="trim">Trim</option>
          <option value="upper">大写</option>
          <option value="lower">小写</option>
        </select>
      </div>

      <div className="skillWizardField">
        <div className="skillWizardLabel">输入</div>
        <textarea className="skillWizardInput" rows={5} value={input} onChange={(e) => setInput(e.target.value)} />
      </div>

      <div className="skillWizardResult">
        <div className="skillWizardResultHeader">
          <div className="skillWizardResultTitle">输出</div>
          <div className="skillWizardActions">
            <button className="btn tiny" onClick={() => props.insertText(output)} disabled={!output.trim()} type="button">
              插入
            </button>
            <button className="btn tiny primary" onClick={() => void props.sendText(output)} disabled={!output.trim()} type="button">
              发送
            </button>
          </div>
        </div>

        {outputError ? <div className="errorText">{outputError}</div> : null}

        <div className="skillWizardField" style={{ marginTop: 8 }}>
          <div className="skillWizardLabel">保存路径（相对工作区）</div>
          <input className="skillWizardInput" value={savePath} onChange={(e) => setSavePath(e.target.value)} />
        </div>
        <div className="skillWizardActions" style={{ marginTop: 8 }}>
          <button className="btn tiny" onClick={() => void save()} disabled={!output.trim()} type="button">
            保存
          </button>
          {saved ? <span className="hint">{`已保存：${saved}`}</span> : null}
        </div>
        {error ? <div className="errorText">{error}</div> : null}

        <div className="skillWizardPreview">{output ? output : "（输出为空）"}</div>
      </div>
    </div>
  );
};

const manifest: SkillCustomManifestV1 = {
  schemaVersion: 1,
  id: "text_tools",
  title: "文本工具",
  description: "自定义 UI 示例：格式化/转换文本，并插入/发送/保存。",
  version: "0.1.0",
  kind: "custom",
  Renderer
};

export default manifest;

