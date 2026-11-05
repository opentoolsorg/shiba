import React, { useRef, useState } from "react";
import { Plus } from "lucide-react";

export interface WorkQuickAddProps {
  onSubmit(text: string): void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  "aria-label"?: string;
}

export function WorkQuickAdd({
  onSubmit,
  disabled = false,
  placeholder = "Add a task and press Enter",
  className = "",
  "aria-label": ariaLabel,
}: WorkQuickAddProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed && !disabled) {
        onSubmit(trimmed);
        setText("");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setText("");
    }
  };

  return (
    <div
      onClick={() => {
        if (!disabled) {
          inputRef.current?.focus();
        }
      }}
      className={`w-full flex items-center gap-2 px-2.5 h-7 min-h-[28px] border border-dashed border-zinc-200 dark:border-zinc-800 rounded-lg bg-transparent transition-colors focus-within:border-zinc-400 dark:focus-within:border-zinc-600 ${
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-text"
      } ${className}`.trim()}
    >
      <Plus className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 shrink-0" aria-hidden="true" />
      <input
        ref={inputRef}
        type="text"
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel || placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full bg-transparent text-xs sm:text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 dark:placeholder:text-zinc-500 focus:outline-none disabled:cursor-not-allowed"
      />
    </div>
  );
}

export default WorkQuickAdd;
