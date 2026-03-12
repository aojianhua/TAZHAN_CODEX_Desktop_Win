import React, { useEffect, useMemo, useRef, useState } from "react";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

type Props = {
  open: boolean;
  scope: "local" | "remote";
  cwd: string;
  remoteConnected: boolean;
};

type Status = "idle" | "starting" | "ready" | "exited" | "error";

export const TerminalDock: React.FC<Props> = (props) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const disposeInFlightRef = useRef<boolean>(false);

  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function copySelectionToClipboard(): Promise<void> {
    const term = termRef.current;
    if (!term || !term.hasSelection()) {
      return;
    }
    const text = term.getSelection() ?? "";
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Best-effort.
    }
  }

  async function pasteFromClipboard(): Promise<void> {
    const terminalId = terminalIdRef.current;
    if (!terminalId) {
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        return;
      }
      // Normalize newlines so pasted multi-line commands behave like typical terminals.
      const normalized = text.replaceAll("\r\n", "\n").replaceAll("\n", "\r");
      await window.tazhan.terminalWrite({ terminalId, data: normalized });
    } catch {
      // Best-effort.
    }
  }

  const enabled = useMemo(() => {
    if (!props.open) {
      return false;
    }
    if (!props.cwd.trim()) {
      return false;
    }
    if (props.scope === "remote" && !props.remoteConnected) {
      return false;
    }
    return true;
  }, [props.cwd, props.open, props.remoteConnected, props.scope]);

  async function disposeTerminal(): Promise<void> {
    if (disposeInFlightRef.current) {
      return;
    }
    disposeInFlightRef.current = true;
    try {
      const terminalId = terminalIdRef.current;
      terminalIdRef.current = null;
      if (terminalId) {
        try {
          await window.tazhan.terminalDispose({ terminalId });
        } catch {
          // Best-effort.
        }
      }
      try {
        termRef.current?.dispose();
      } catch {
        // Best-effort.
      }
      termRef.current = null;
      fitRef.current = null;
    } finally {
      disposeInFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (!props.open) {
      void disposeTerminal();
      setStatus("idle");
      setError(null);
      return;
    }
  }, [props.open]);

  // Start/restart terminal when scope/cwd changes.
  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }

    let cancelled = false;

    async function start(): Promise<void> {
      setStatus("starting");
      setError(null);
      await disposeTerminal();

      const host = containerRef.current;
      if (!host) {
        setStatus("error");
        setError("终端容器未就绪");
        return;
      }

      const term = new Terminal({
        cursorBlink: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
        fontSize: 12,
        lineHeight: 1.2,
        scrollback: 5000,
        convertEol: true,
        disableStdin: true
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      host.innerHTML = "";
      term.open(host);
      fit.fit();

      termRef.current = term;
      fitRef.current = fit;

      const cols = term.cols || 80;
      const rows = term.rows || 24;

      const created = await window.tazhan.terminalCreate({ scope: props.scope, cwd: props.cwd, cols, rows });
      if (cancelled) {
        return;
      }
      if (!created.ok || !created.terminalId) {
        setStatus("error");
        setError(created.error ?? "终端启动失败");
        term.writeln("");
        term.writeln("Terminal create failed.");
        if (created.error) {
          term.writeln(created.error);
        }
        return;
      }

      terminalIdRef.current = created.terminalId;
      term.options.disableStdin = false;
      setStatus("ready");

      term.attachCustomKeyEventHandler((ev) => {
        const mod = ev.ctrlKey || ev.metaKey;
        const key = String(ev.key ?? "").toLowerCase();
        const code = String(ev.code ?? "");
        if (mod && ev.shiftKey && (code === "KeyC" || key === "c")) {
          if (term.hasSelection()) {
            void copySelectionToClipboard();
            return false;
          }
          return true;
        }
        if (mod && ev.shiftKey && (code === "KeyV" || key === "v")) {
          void pasteFromClipboard();
          return false;
        }
        if (mod && !ev.shiftKey && (code === "KeyC" || key === "c") && term.hasSelection()) {
          void copySelectionToClipboard();
          return false;
        }
        if (mod && !ev.shiftKey && (code === "KeyV" || key === "v")) {
          void pasteFromClipboard();
          return false;
        }
        return true;
      });

      // Wire input -> backend.
      term.onData((data) => {
        const terminalId = terminalIdRef.current;
        if (!terminalId) {
          return;
        }
        void window.tazhan.terminalWrite({ terminalId, data });
      });
    }

    void start();
    return () => {
      cancelled = true;
    };
  }, [enabled, props.cwd, props.scope]);

  // Resize handling.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const host = containerRef.current;
    if (!host) {
      return;
    }

    const obs = new ResizeObserver(() => {
      const term = termRef.current;
      const fit = fitRef.current;
      const terminalId = terminalIdRef.current;
      if (!term || !fit) {
        return;
      }
      fit.fit();
      if (terminalId) {
        void window.tazhan.terminalResize({ terminalId, cols: term.cols || 80, rows: term.rows || 24 });
      }
    });
    obs.observe(host);
    return () => obs.disconnect();
  }, [enabled]);

  // Data stream -> xterm.
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const unsub = window.tazhan.onTerminalEvent((ev) => {
      const terminalId = terminalIdRef.current;
      if (!terminalId || ev.terminalId !== terminalId) {
        return;
      }
      const term = termRef.current;
      if (!term) {
        return;
      }
      if (ev.type === "data") {
        term.write(ev.data);
        return;
      }
      if (ev.type === "error") {
        setStatus("error");
        setError(ev.error);
        term.writeln("");
        term.writeln(`[terminal error] ${ev.error}`);
        return;
      }
      if (ev.type === "exit") {
        setStatus("exited");
        term.writeln("");
        term.writeln(`[terminal exited] code=${ev.exitCode ?? "null"} signal=${ev.signal ?? "null"}`);
        return;
      }
    });
    return () => unsub();
  }, [enabled]);

  return (
    <div
      className="terminalDockMinimal"
      onContextMenu={(e) => {
        // Right click to paste is a common terminal convention.
        e.preventDefault();
        void pasteFromClipboard();
      }}
      title={!enabled ? (props.scope === "remote" ? "云端未连接或工作区为空" : "工作区为空") : ""}
    >
      <div ref={containerRef} className="terminalDockXterm" />
      {status === "error" && error ? <div className="terminalDockOverlay">{error}</div> : null}
    </div>
  );
};
