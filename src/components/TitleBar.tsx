import React from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";

const appWindow = getCurrentWindow();

export const TitleBar: React.FC = () => {
  const handleMinimize = async () => {
    await appWindow.minimize();
  };

  const handleMaximize = async () => {
    await appWindow.toggleMaximize();
  };

  const handleClose = async () => {
    await appWindow.close();
  };

  // Frameless windows can only be moved by elements explicitly tagged
  // data-tauri-drag-region. Children with pointer-events:none let clicks
  // bubble to the strip, so the brand text is also draggable while the
  // window-control buttons (which have pointer-events:auto) stay clickable.
  return (
    <div className="drag-strip" data-tauri-drag-region>
      <span className="brand" data-tauri-drag-region>
        <span className="brand-name">BillyDian</span>
        <span className="brand-by">by puzix</span>
      </span>
      <div className="win-controls">
        <button className="win-btn" onClick={handleMinimize} aria-label="Minimize">
          <Minus size={14} />
        </button>
        <button className="win-btn" onClick={handleMaximize} aria-label="Maximize">
          <Square size={11} />
        </button>
        <button className="win-btn close" onClick={handleClose} aria-label="Close">
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
