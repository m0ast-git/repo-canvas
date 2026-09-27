import React, { memo } from "react";
import { CheckIcon, ClockIcon, WarningCircleIcon, SpinnerGapIcon, PauseIcon } from "./design-system/icons.jsx";

const statuses = {
  ready: ["В системе", CheckIcon], verified: ["Проверено", CheckIcon],
  planned: ["Запланировано", ClockIcon], running: ["В работе", SpinnerGapIcon],
  paused: ["Приостановлено", PauseIcon], question: ["Нужен ответ", WarningCircleIcon],
  error: ["Ошибка", WarningCircleIcon],
};

export const WorkActivity = memo(function WorkActivity({ count = 1, pulsing = true }) {
  const label = `${pulsing ? "Сейчас в работе" : "В работе на этом снимке"}${count > 1 ? `: ${count} задач` : ""}`;
  return <span className="work-activity" data-pulsing={pulsing} role="img" aria-label={label} title={label}><i aria-hidden="true"/>{count > 1 && <b aria-hidden="true">{count}</b>}</span>;
});

export const CanvasCard = memo(function CanvasCard({title, description, icon: Icon, kindLabel="", status="ready", selected, detail="full", activeCount=0}) {
  const [statusLabel, StatusIcon] = statuses[status] || statuses.ready;
  const exceptional = !["ready", "verified"].includes(status);
  const detailed = detail === "full" || detail === "preview";
  return <div className={`rc-module canvas-card ${selected ? "is-selected" : ""}`} data-detail={detail} data-status={status}>
    <header><Icon className="canvas-card-icon" aria-hidden="true"/><strong>{title}</strong><span className={`canvas-card-status status-${status}`} aria-label={statusLabel}>{exceptional && <StatusIcon aria-hidden="true"/>}</span></header>
    {detailed && <p>{description}</p>}
    {detail === "full" && <small className={`canvas-card-state status-${status}`}>{activeCount ? `${exceptional ? statusLabel + " · " : ""}В работе` : exceptional ? statusLabel : kindLabel}</small>}
  </div>;
});
