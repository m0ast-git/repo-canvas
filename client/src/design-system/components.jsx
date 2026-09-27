import React, { useEffect, useId, useRef } from "react";
import { CheckIcon, ClockIcon, InfoIcon, PauseIcon, SpinnerGapIcon, WarningCircleIcon, XIcon } from "./icons.jsx";
import "./tokens.css";
import "./components.css";

const classes = (...items) => items.filter(Boolean).join(" ");

export function Button({ variant = "secondary", icon: Icon, loading = false, children, className, disabled, ...props }) {
  return <button type="button" className={classes("rc-button", "rc-button--" + variant, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading ? <SpinnerGapIcon className="rc-spinner" aria-hidden="true" size={18} /> : Icon && <Icon aria-hidden="true" size={18} />}
    {children}
  </button>;
}

export function IconButton({ label, icon: Icon, className, ...props }) {
  return <button type="button" className={classes("rc-icon-button", className)} aria-label={label} title={label} {...props}><Icon size={20} aria-hidden="true" /></button>;
}

const statusDetails = {
  ready: { label: "В системе", Icon: CheckIcon },
  verified: { label: "Проверено", Icon: CheckIcon },
  planned: { label: "Запланировано", Icon: ClockIcon },
  running: { label: "В работе", Icon: SpinnerGapIcon },
  paused: { label: "Приостановлено", Icon: PauseIcon },
  question: { label: "Нужен ответ", Icon: WarningCircleIcon },
  error: { label: "Ошибка", Icon: WarningCircleIcon },
};

export function StatusBadge({ status = "ready", children, className }) {
  const { label, Icon } = statusDetails[status] || statusDetails.ready;
  return <span className={classes("rc-status", "rc-status--" + status, className)}><Icon size={14} aria-hidden="true" />{children || label}</span>;
}

export function TextField({ label, hint, error, multiline = false, id, className, ...props }) {
  const generatedId = useId(), fieldId = id || generatedId;
  const Control = multiline ? "textarea" : "input";
  return <div className={classes("rc-field", className)}>
    <label htmlFor={fieldId}>{label}</label>
    <Control id={fieldId} aria-invalid={Boolean(error)} aria-describedby={hint || error ? fieldId + "-description" : undefined} {...props} />
    {(error || hint) && <small id={fieldId + "-description"} className={error ? "rc-field-error" : ""}>{error || hint}</small>}
  </div>;
}

export function SelectField({ label, id, children, ...props }) {
  const generatedId = useId(), fieldId = id || generatedId;
  return <div className="rc-field"><label htmlFor={fieldId}>{label}</label><select id={fieldId} {...props}>{children}</select></div>;
}

export function ModuleCard({ title, description, icon: Icon, selected = false, status, className }) {
  return <div className={classes("rc-module", selected && "is-selected", className)}>
    <div className="rc-module-content">{Icon && <Icon className="rc-module-icon" size={28} aria-hidden="true" />}
      <div className="rc-module-copy"><strong>{title}</strong><p>{description}</p></div>
    </div>
    {status && <StatusBadge status={status} />}
  </div>;
}

export function Inspector({ title, onClose, status, children, actions, className }) {
  return <aside className={classes("rc-inspector", className)} aria-label="Сведения об элементе">
    <header><h2>{title}</h2><IconButton icon={XIcon} label="Закрыть сведения" onClick={onClose} /></header>
    <div className="rc-inspector-content">{status && <StatusBadge status={status} />}{children}</div>
    {actions && <footer>{actions}</footer>}
  </aside>;
}

export function Dialog({ open, title, onClose, children, actions }) {
  const ref = useRef(null), headingId = useId();
  const keepFocus = event => {
    if (event.key !== "Tab") return;
    const controls = [...ref.current.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    return () => { if (dialog.open) dialog.close(); };
  }, [open]);
  return <dialog ref={ref} className="rc-dialog" aria-labelledby={headingId} onKeyDown={keepFocus} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === ref.current) onClose(); }}>
    <header><h2 id={headingId}>{title}</h2><IconButton label="Закрыть диалог" icon={XIcon} onClick={onClose} /></header>
    <div className="rc-dialog-content">{children}</div>
    {actions && <footer>{actions}</footer>}
  </dialog>;
}

export function Notice({ tone = "neutral", title, children }) {
  return <div className={classes("rc-notice", "rc-notice--" + tone)} role={tone === "error" ? "alert" : "status"}><InfoIcon size={20} aria-hidden="true" /><div><strong>{title}</strong>{children && <p>{children}</p>}</div></div>;
}
