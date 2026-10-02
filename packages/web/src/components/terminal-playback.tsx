"use client";

import { useEffect, useState } from "react";
import { demoCommand, demoFrames, demoOutput, demoReceipt } from "../data/demo-transcript";

export function TerminalPlayback() {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const initial = window.setTimeout(() => {
      if (motion.matches) setFrame(demoFrames.length - 1);
      else setPlaying(true);
    }, 0);
    const stopForReducedMotion = () => {
      if (motion.matches) setPlaying(false);
    };
    motion.addEventListener("change", stopForReducedMotion);
    return () => {
      window.clearTimeout(initial);
      motion.removeEventListener("change", stopForReducedMotion);
    };
  }, []);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setFrame((current) => {
        if (current === demoFrames.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 1100);
    return () => window.clearInterval(timer);
  }, [playing]);

  return (
    <div className="terminal-window" aria-label="Fixed-command Twin demonstration">
      <div className="terminal-toolbar">
        <div className="terminal-dots" aria-hidden="true"><i /><i /><i /></div>
        <span>fixed-command demo · no AI agent</span>
        <span className="terminal-status">settled</span>
      </div>
      <div className="terminal-body">
        <p className="terminal-command"><span aria-hidden="true">$ </span>{demoCommand}</p>
        <pre aria-label="Selected frames from recorded Twin output">{demoFrames[frame].join("\n")}</pre>
      </div>
      <div className="terminal-controls">
        <button type="button" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "Pause recording" : "Play recording"}>
          {playing ? "pause" : "play"}
        </button>
        <button type="button" onClick={() => { setFrame(0); setPlaying(true); }} aria-label="Replay recording">replay</button>
        <span aria-hidden="true">{frame + 1} / {demoFrames.length}</span>
      </div>
      <details className="transcript-details">
        <summary>read complete output and receipt</summary>
        <pre>{demoOutput}{"\n"}{demoReceipt}</pre>
      </details>
    </div>
  );
}
