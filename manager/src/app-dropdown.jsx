import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { dropdownSearchEnabled, filterDropdownOptions, resolveDropdownEnterOption } from "./dropdown-options.js";

function sameValue(left, right) {
  return String(left ?? "") === String(right ?? "");
}

export function AppDropdown({
  value,
  options = [],
  onChange,
  disabled = false,
  ariaLabel = "Chọn giá trị",
  placeholder = "Chọn giá trị",
  searchPlaceholder = "Tìm trong danh sách…",
  searchable,
  searchThreshold,
  getSearchText,
  renderValue,
  renderOption,
  createOption,
  emptyText = "Không tìm thấy lựa chọn phù hợp.",
  className = "",
  compact = false,
  showCheck = true
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const menuId = useId();
  const selected = options.find((option) => sameValue(option?.value, value));
  const useSearch = dropdownSearchEnabled(options, searchable, searchThreshold);
  const filtered = useMemo(() => filterDropdownOptions(options, query, getSearchText), [getSearchText, options, query]);
  const customOption = useMemo(() => {
    const trimmed = query.trim();
    return trimmed && typeof createOption === "function" ? createOption(trimmed, filtered, options) : null;
  }, [createOption, filtered, options, query]);
  const visibleOptions = customOption ? [customOption, ...filtered] : filtered;

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) {
        setOpen(false);
        setQuery("");
      }
    };
    const escape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        setQuery("");
        rootRef.current?.querySelector(".app-dropdown-trigger")?.focus();
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  useEffect(() => {
    if (open && useSearch) queueMicrotask(() => searchRef.current?.focus());
  }, [open, useSearch]);

  const toggle = () => {
    if (disabled) return;
    setOpen((current) => {
      if (current) setQuery("");
      return !current;
    });
  };
  const choose = (option) => {
    if (option?.disabled) return;
    onChange?.(option.value, option);
    setOpen(false);
    setQuery("");
  };
  const moveOptionFocus = (event) => {
    if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
    const buttons = [...(rootRef.current?.querySelectorAll(".app-dropdown-option:not(:disabled)") || [])];
    if (!buttons.length) return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement);
    const delta = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + delta + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div className={`app-dropdown ${open ? "is-open" : ""} ${disabled ? "is-disabled" : ""} ${compact ? "is-compact" : ""} ${className}`.trim()} ref={rootRef}>
      <button
        type="button"
        className="app-dropdown-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key) && open) {
            moveOptionFocus(event);
            return;
          }
          if (["ArrowDown", "Enter", " "].includes(event.key) && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={`app-dropdown-value ${selected ? "" : "is-placeholder"}`}>{renderValue ? renderValue(selected) : <strong>{selected?.label || placeholder}</strong>}</span>
        <svg className="app-dropdown-chevron" aria-hidden="true" viewBox="0 0 16 16"><path d="m4 6 4 4 4-4" /></svg>
      </button>
      {open && (
        <div className="app-dropdown-menu" onKeyDown={moveOptionFocus}>
          {useSearch && (
            <div className="app-dropdown-search">
              <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  const option = resolveDropdownEnterOption(filtered, query, customOption);
                  if (!option) return;
                  event.preventDefault();
                  event.stopPropagation();
                  choose(option);
                }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
              />
              {query && <button type="button" aria-label="Xóa từ khóa" onClick={() => { setQuery(""); searchRef.current?.focus(); }}>×</button>}
            </div>
          )}
          <div className="app-dropdown-options" id={menuId} role="listbox" aria-label={ariaLabel}>
            {visibleOptions.map((option, index) => {
              const active = sameValue(option.value, value);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`app-dropdown-option ${active ? "is-selected" : ""} ${option.className || ""}`.trim()}
                  key={String(option.key ?? option.value ?? index)}
                  disabled={option.disabled}
                  onClick={() => choose(option)}
                  style={option.style}
                >
                  <span className="app-dropdown-option-content">{renderOption ? renderOption(option, { active, index }) : <span className="app-dropdown-option-copy"><strong>{option.label}</strong>{option.hint && <small>{option.hint}</small>}</span>}</span>
                  {showCheck && active && <span className="app-dropdown-check" aria-hidden="true">✓</span>}
                </button>
              );
            })}
            {!visibleOptions.length && <div className="app-dropdown-empty">{emptyText}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
